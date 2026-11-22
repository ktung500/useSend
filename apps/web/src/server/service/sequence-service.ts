import { z } from "zod";
import { db } from "../db";
import { logger } from "../logger/log";
import { addOrUpdateContact } from "./contact-service";
import { EmailQueueService } from "./email-queue-service";
import { SuppressionService } from "./suppression-service";

/**
 * Fork: email sequences. A sequence is ordered steps (a day offset from enrollment
 * plus variants); the first variant whose conditions match the contact's current
 * properties is sent, none matching skips the step. The scheduler job calls
 * processDueEnrollments every 30s. Emails go out on the marketing queue, so the
 * worker fills {{usesend_unsubscribe_url}} and honors UNSUBSCRIBE suppressions.
 */

const DAY_MS = 86_400_000;

export const conditionSchema = z.object({
  prop: z.string().min(1),
  op: z.enum(["eq", "neq", "lt", "gt", "exists", "not_exists", "within_days", "older_than_days"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});
const variantSchema = z.object({
  when: z.array(conditionSchema).optional(),
  subject: z.string().min(1),
  html: z.string().min(1),
  text: z.string().optional(),
});
export const stepsSchema = z
  .array(z.object({ day: z.number().min(0), variants: z.array(variantSchema).min(1) }))
  .min(1)
  .refine((steps) => steps.every((s, i) => i === 0 || s.day >= steps[i - 1]!.day), "Step days must not go backwards");

export type Condition = z.infer<typeof conditionSchema>;
export type Steps = z.infer<typeof stepsSchema>;

export function matches(conditions: Condition[], props: Record<string, unknown>, now: Date) {
  return conditions.every((c) => {
    const v = props[c.prop];
    const present = v !== undefined && v !== null && v !== "";
    const days = (now.getTime() - Date.parse(String(v))) / DAY_MS;
    switch (c.op) {
      case "exists": return present;
      case "not_exists": return !present;
      case "eq": return present && String(v) === String(c.value);
      case "neq": return !present || String(v) !== String(c.value);
      case "lt": return present && Number(v) < Number(c.value);
      case "gt": return present && Number(v) > Number(c.value);
      case "within_days": return present && !Number.isNaN(days) && days <= Number(c.value);
      case "older_than_days": return present && !Number.isNaN(days) && days > Number(c.value);
    }
  });
}

export const sendAt = (startedAt: Date, steps: Steps, index: number) =>
  index < steps.length ? new Date(startedAt.getTime() + steps[index]!.day * DAY_MS) : null;

/** The newest due step at or after `fromStep`. Missed steps are skipped so a late run never sends two in a row. */
export function dueStepIndex(startedAt: Date, steps: Steps, fromStep: number, now: Date) {
  let due: number | null = null;
  for (let i = fromStep; i < steps.length; i++) if (sendAt(startedAt, steps, i)!.getTime() <= now.getTime()) due = i;
  return due;
}

export async function enrollInSequence(
  sequence: { id: string; teamId: number; contactBookId: string; steps: unknown },
  input: { email: string; firstName?: string; lastName?: string; properties?: Record<string, string>; startedAt?: Date },
) {
  const contact = await addOrUpdateContact(
    sequence.contactBookId,
    { email: input.email, firstName: input.firstName, lastName: input.lastName, properties: input.properties },
    sequence.teamId,
  );
  const startedAt = input.startedAt ?? new Date();
  const steps = stepsSchema.parse(sequence.steps);
  // Re-enrolling is a no-op: a contact goes through a sequence once.
  return db.sequenceEnrollment.upsert({
    where: { sequenceId_contactId: { sequenceId: sequence.id, contactId: contact.id } },
    create: { sequenceId: sequence.id, contactId: contact.id, startedAt, nextSendAt: sendAt(startedAt, steps, 0) },
    update: {},
  });
}

export async function processEnrollment(id: string, now = new Date()) {
  const e = await db.sequenceEnrollment.findUnique({ where: { id }, include: { sequence: true, contact: true } });
  if (!e || e.status !== "ACTIVE" || !e.sequence.active) return;
  const seq = e.sequence;
  const steps = stepsSchema.parse(seq.steps);
  const props = (e.contact.properties ?? {}) as Record<string, unknown>;
  // Every write is guarded on the step we read, so an overlapping run can't double-send.
  const guard = { id, step: e.step, status: "ACTIVE" as const };
  const stop = (stopReason: string) =>
    db.sequenceEnrollment.updateMany({ where: guard, data: { status: "STOPPED", stopReason, nextSendAt: null } });

  if (!e.contact.subscribed) return stop("unsubscribed");
  if (seq.stopWhen && matches(z.array(conditionSchema).parse(seq.stopWhen), props, now)) return stop("stop_condition");
  const suppressed = await SuppressionService.checkMultipleEmails([e.contact.email], seq.teamId);
  if (suppressed[e.contact.email]) return stop("suppressed");

  const index = dueStepIndex(e.startedAt, steps, e.step, now);
  if (index === null) {
    // Not due (the sequence changed since nextSendAt was set): reschedule from the current steps.
    await db.sequenceEnrollment.updateMany({ where: guard, data: { nextSendAt: sendAt(e.startedAt, steps, e.step) } });
    return;
  }
  const done = index + 1 >= steps.length;
  const advance = { step: index + 1, nextSendAt: sendAt(e.startedAt, steps, index + 1), status: done ? ("DONE" as const) : ("ACTIVE" as const) };
  const variant = steps[index]!.variants.find((v) => !v.when || matches(v.when, props, now));
  if (!variant) {
    await db.sequenceEnrollment.updateMany({ where: guard, data: advance });
    return;
  }

  const domain = await db.domain.findUnique({ where: { id: seq.domainId }, select: { id: true, region: true } });
  if (!domain) {
    logger.error({ sequenceId: seq.id }, "Sequence domain missing; enrollment left due");
    return;
  }
  const email = await db.$transaction(async (tx) => {
    const moved = await tx.sequenceEnrollment.updateMany({ where: guard, data: advance });
    if (moved.count === 0) return null;
    return tx.email.create({
      data: {
        to: [e.contact.email],
        from: seq.from,
        replyTo: seq.replyTo,
        subject: variant.subject,
        html: variant.html,
        text: variant.text,
        teamId: seq.teamId,
        domainId: domain.id,
        contactId: e.contact.id,
        sequenceEnrollmentId: id,
        sequenceStep: index,
        latestStatus: "QUEUED",
      },
    });
  });
  // shortcut: a crash between this commit and the queue call leaves the email QUEUED and unsent; add a sweep if that ever shows up.
  if (email) await EmailQueueService.queueEmail(email.id, seq.teamId, domain.region, false);
}

export async function processDueEnrollments(now = new Date()) {
  const due = await db.sequenceEnrollment.findMany({
    where: { status: "ACTIVE", nextSendAt: { lte: now }, sequence: { active: true } },
    orderBy: { nextSendAt: "asc" },
    select: { id: true },
    take: 100,
  });
  for (const { id } of due) {
    try {
      await processEnrollment(id, now);
    } catch (err) {
      logger.error({ err, enrollmentId: id }, "Sequence step failed");
    }
  }
  return due.length;
}
