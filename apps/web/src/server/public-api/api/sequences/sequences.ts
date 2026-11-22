import { createRoute, z } from "@hono/zod-openapi";
import { PublicAPIApp } from "~/server/public-api/hono";
import { UnsendApiError } from "~/server/public-api/api-error";
import { db } from "~/server/db";
import { validateDomainFromEmail } from "~/server/service/domain-service";
import { conditionSchema, enrollInSequence, stepsSchema } from "~/server/service/sequence-service";

// Fork: email sequence API. A domain-restricted API key only sees sequences that send from its domain.

const nameParam = z.object({
  name: z.string().min(1).max(100).openapi({ param: { name: "name", in: "path" }, example: "welcome" }),
});
const json = <T extends z.ZodTypeAny>(schema: T) => ({ content: { "application/json": { schema } } });

type Team = { id: number; apiKey: { domainId: number | null } };

async function findSequence(team: Team, name: string) {
  const sequence = await db.sequence.findUnique({ where: { teamId_name: { teamId: team.id, name } } });
  if (!sequence || (team.apiKey.domainId && sequence.domainId !== team.apiKey.domainId)) {
    throw new UnsendApiError({ code: "NOT_FOUND", message: "Sequence not found" });
  }
  return sequence;
}

const putSequence = createRoute({
  method: "put",
  path: "/v1/sequences/{name}",
  request: {
    params: nameParam,
    body: {
      required: true,
      ...json(
        z.object({
          contactBookId: z.string().min(3),
          from: z.string().min(3),
          replyTo: z.array(z.string()).optional(),
          steps: stepsSchema,
          stopWhen: z.array(conditionSchema).optional(),
          active: z.boolean().optional(),
        }),
      ),
    },
  },
  responses: { 200: { ...json(z.object({ id: z.string() })), description: "Sequence created or updated" } },
});

const enroll = createRoute({
  method: "post",
  path: "/v1/sequences/{name}/enroll",
  request: {
    params: nameParam,
    body: {
      required: true,
      ...json(
        z.object({
          email: z.string().email(),
          firstName: z.string().optional(),
          lastName: z.string().optional(),
          properties: z.record(z.string()).optional(),
          startedAt: z.string().datetime({ offset: true }).optional().openapi({ description: "Day 0 of the sequence; defaults to now" }),
        }),
      ),
    },
  },
  responses: {
    200: { ...json(z.object({ enrollmentId: z.string(), status: z.string() })), description: "Enrolled (a repeat call is a no-op)" },
  },
});

const stop = createRoute({
  method: "post",
  path: "/v1/sequences/{name}/stop",
  request: { params: nameParam, body: { required: true, ...json(z.object({ email: z.string().email() })) } },
  responses: { 200: { ...json(z.object({ stopped: z.number() })), description: "Enrollment stopped" } },
});

const listEnrollments = createRoute({
  method: "get",
  path: "/v1/sequences/{name}/enrollments",
  request: {
    params: nameParam,
    query: z.object({ status: z.enum(["ACTIVE", "DONE", "STOPPED"]).optional(), limit: z.coerce.number().min(1).max(500).optional() }),
  },
  responses: {
    200: {
      ...json(
        z.array(
          z.object({
            id: z.string(),
            email: z.string(),
            status: z.string(),
            step: z.number(),
            startedAt: z.string(),
            nextSendAt: z.string().nullable(),
            stopReason: z.string().nullable(),
          }),
        ),
      ),
      description: "Enrollments, newest first",
    },
  },
});

export default function sequenceRoutes(app: PublicAPIApp) {
  app.openapi(putSequence, async (c) => {
    const team = c.var.team;
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    const domain = await validateDomainFromEmail(body.from, team.id);
    if (team.apiKey.domainId && domain.id !== team.apiKey.domainId) {
      throw new UnsendApiError({ code: "FORBIDDEN", message: "This API key can't send from that domain" });
    }
    const book = await db.contactBook.findFirst({ where: { id: body.contactBookId, teamId: team.id }, select: { id: true } });
    if (!book) throw new UnsendApiError({ code: "BAD_REQUEST", message: "Contact book not found" });

    const data = {
      contactBookId: book.id,
      domainId: domain.id,
      from: body.from,
      replyTo: body.replyTo ?? [],
      steps: body.steps,
      stopWhen: body.stopWhen ?? undefined,
      active: body.active ?? true,
    };
    const sequence = await db.sequence.upsert({
      where: { teamId_name: { teamId: team.id, name } },
      create: { teamId: team.id, name, ...data },
      update: data,
    });
    // Steps may have changed: make every active enrollment due so the scheduler re-times it.
    await db.sequenceEnrollment.updateMany({ where: { sequenceId: sequence.id, status: "ACTIVE" }, data: { nextSendAt: new Date() } });
    return c.json({ id: sequence.id });
  });

  app.openapi(enroll, async (c) => {
    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    const sequence = await findSequence(c.var.team, name);
    const enrollment = await enrollInSequence(sequence, { ...body, startedAt: body.startedAt ? new Date(body.startedAt) : undefined });
    return c.json({ enrollmentId: enrollment.id, status: enrollment.status });
  });

  app.openapi(stop, async (c) => {
    const { name } = c.req.valid("param");
    const { email } = c.req.valid("json");
    const sequence = await findSequence(c.var.team, name);
    const result = await db.sequenceEnrollment.updateMany({
      where: { sequenceId: sequence.id, status: "ACTIVE", contact: { email: { equals: email, mode: "insensitive" } } },
      data: { status: "STOPPED", stopReason: "api", nextSendAt: null },
    });
    return c.json({ stopped: result.count });
  });

  app.openapi(listEnrollments, async (c) => {
    const { name } = c.req.valid("param");
    const { status, limit } = c.req.valid("query");
    const sequence = await findSequence(c.var.team, name);
    const rows = await db.sequenceEnrollment.findMany({
      where: { sequenceId: sequence.id, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit ?? 100,
      include: { contact: { select: { email: true } } },
    });
    return c.json(
      rows.map((r) => ({
        id: r.id,
        email: r.contact.email,
        status: r.status,
        step: r.step,
        startedAt: r.startedAt.toISOString(),
        nextSendAt: r.nextSendAt?.toISOString() ?? null,
        stopReason: r.stopReason,
      })),
    );
  });
}
