import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb, mockQueue, mockSuppression } = vi.hoisted(() => {
  const tx = { sequenceEnrollment: { updateMany: vi.fn() }, email: { create: vi.fn() } };
  return {
    mockDb: {
      sequenceEnrollment: { findUnique: vi.fn(), updateMany: vi.fn() },
      domain: { findUnique: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
      tx,
    },
    mockQueue: { queueEmail: vi.fn() },
    mockSuppression: { checkMultipleEmails: vi.fn() },
  };
});

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/server/service/email-queue-service", () => ({ EmailQueueService: mockQueue }));
vi.mock("~/server/service/suppression-service", () => ({ SuppressionService: mockSuppression }));
vi.mock("~/server/service/contact-service", () => ({ addOrUpdateContact: vi.fn() }));
vi.mock("~/server/logger/log", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { dueStepIndex, matches, processEnrollment } from "~/server/service/sequence-service";

const DAY = 86_400_000;
const start = new Date("2026-11-01T10:00:00Z");
const at = (d: number) => new Date(start.getTime() + d * DAY);
const v = (subject: string, when?: unknown) => ({ subject, html: `<p>${subject}</p>`, ...(when ? { when } : {}) });
const steps = [
  { day: 0, variants: [v("pro-0", [{ prop: "tier", op: "eq", value: "pro" }]), v("free-0")] },
  { day: 1, variants: [v("queue-low", [{ prop: "videos_queued", op: "lt", value: 6 }])] },
  { day: 3, variants: [v("day-3")] },
];

describe("conditions", () => {
  it("compares strings, numbers, presence and dates", () => {
    const now = at(10);
    const props = { tier: "pro", videos_queued: "4", last_post_at: at(8).toISOString() };
    expect(matches([{ prop: "tier", op: "eq", value: "pro" }], props, now)).toBe(true);
    expect(matches([{ prop: "tier", op: "neq", value: "pro" }], props, now)).toBe(false);
    expect(matches([{ prop: "missing", op: "neq", value: "pro" }], props, now)).toBe(true);
    expect(matches([{ prop: "videos_queued", op: "lt", value: 6 }], props, now)).toBe(true);
    expect(matches([{ prop: "last_post_at", op: "within_days", value: 7 }], props, now)).toBe(true);
    expect(matches([{ prop: "last_post_at", op: "older_than_days", value: 7 }], props, now)).toBe(false);
    expect(matches([{ prop: "missing", op: "exists" }], props, now)).toBe(false);
  });
});

describe("due step", () => {
  it("skips missed steps and waits for future ones", () => {
    expect(dueStepIndex(start, steps as never, 0, at(0.1))).toBe(0);
    expect(dueStepIndex(start, steps as never, 1, at(0.5))).toBeNull();
    expect(dueStepIndex(start, steps as never, 1, at(5))).toBe(2);
  });
});

describe("processEnrollment", () => {
  const enrollment = (props: Record<string, string>, over: object = {}) => ({
    id: "en1", status: "ACTIVE", step: 0, startedAt: start,
    sequence: { id: "seq1", teamId: 7, domainId: 3, from: "Kevin <kevin@cloey.app>", replyTo: [], steps, stopWhen: null, active: true },
    contact: { id: "c1", email: "a@b.co", subscribed: true, properties: props },
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockSuppression.checkMultipleEmails.mockResolvedValue({});
    mockDb.domain.findUnique.mockResolvedValue({ id: 3, region: "us-west-1" });
    mockDb.tx.sequenceEnrollment.updateMany.mockResolvedValue({ count: 1 });
    mockDb.tx.email.create.mockResolvedValue({ id: "em1" });
  });

  it("sends the first matching variant, advances, then queues", async () => {
    mockDb.sequenceEnrollment.findUnique.mockResolvedValue(enrollment({ tier: "pro" }));
    await processEnrollment("en1", at(0.1));
    expect(mockDb.tx.sequenceEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: "en1", step: 0, status: "ACTIVE" },
      data: { step: 1, nextSendAt: at(1), status: "ACTIVE" },
    });
    expect(mockDb.tx.email.create.mock.calls[0]?.[0].data).toMatchObject({ subject: "pro-0", to: ["a@b.co"], sequenceStep: 0 });
    expect(mockQueue.queueEmail).toHaveBeenCalledWith("em1", 7, "us-west-1", false);
  });

  it("does not send when another run already advanced the step", async () => {
    mockDb.sequenceEnrollment.findUnique.mockResolvedValue(enrollment({}));
    mockDb.tx.sequenceEnrollment.updateMany.mockResolvedValue({ count: 0 });
    await processEnrollment("en1", at(0.1));
    expect(mockDb.tx.email.create).not.toHaveBeenCalled();
    expect(mockQueue.queueEmail).not.toHaveBeenCalled();
  });

  it("skips a step with no matching variant without sending", async () => {
    mockDb.sequenceEnrollment.findUnique.mockResolvedValue(enrollment({ videos_queued: "9" }, { step: 1 }));
    await processEnrollment("en1", at(1.1));
    expect(mockDb.sequenceEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: "en1", step: 1, status: "ACTIVE" },
      data: { step: 2, nextSendAt: at(3), status: "ACTIVE" },
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it("stops unsubscribed contacts", async () => {
    mockDb.sequenceEnrollment.findUnique.mockResolvedValue(enrollment({}, { contact: { id: "c1", email: "a@b.co", subscribed: false, properties: {} } }));
    await processEnrollment("en1", at(0.1));
    expect(mockDb.sequenceEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: "en1", step: 0, status: "ACTIVE" },
      data: { status: "STOPPED", stopReason: "unsubscribed", nextSendAt: null },
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});
