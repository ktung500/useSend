import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: { suppressionList: { findUnique: vi.fn(), upsert: vi.fn() } },
}));

vi.mock("~/server/db", () => ({ db: mockDb }));
vi.mock("~/env", () => ({
  env: { NEXTAUTH_SECRET: "test-secret", NEXTAUTH_URL: "https://send.example" },
}));

import {
  applyEmailUnsubscribe,
  createEmailUnsubUrls,
  unsubscribeEmail,
  verifyEmailUnsubLink,
} from "~/server/service/email-unsubscribe-service";

const params = (url: string) => {
  const u = new URL(url);
  return { id: u.searchParams.get("id")!, hash: u.searchParams.get("hash")! };
};

describe("email unsubscribe links", () => {
  beforeEach(() => vi.clearAllMocks());

  it("round-trips team and normalized email", () => {
    const { pageUrl, oneClickUrl } = createEmailUnsubUrls(7, " Ann@Example.com ");
    expect(pageUrl.startsWith("https://send.example/unsubscribe/email?")).toBe(true);
    expect(oneClickUrl.startsWith("https://send.example/api/unsubscribe-email-oneclick?")).toBe(true);
    const { id, hash } = params(pageUrl);
    expect(verifyEmailUnsubLink(id, hash)).toEqual({ teamId: 7, email: "ann@example.com" });
  });

  it("rejects a tampered team or hash", () => {
    const { id, hash } = params(createEmailUnsubUrls(7, "ann@example.com").pageUrl);
    expect(() => verifyEmailUnsubLink(id.replace(/^7/, "8"), hash)).toThrow("Invalid unsubscribe link");
    expect(() => verifyEmailUnsubLink(id, hash.replace(/.$/, "0"))).toThrow();
  });

  it("leaves emails without the placeholder alone", async () => {
    const email = { teamId: 1, to: ["a@b.co"], html: "<p>Receipt</p>", campaignId: null };
    expect(await applyEmailUnsubscribe(email, "Receipt")).toBeNull();
    expect(mockDb.suppressionList.findUnique).not.toHaveBeenCalled();
  });

  it("fills the link and one-click header for a subscribed recipient", async () => {
    mockDb.suppressionList.findUnique.mockResolvedValue(null);
    const email = { teamId: 1, to: ["a@b.co"], html: '<a href="{{ usesend_unsubscribe_url }}">x</a>', campaignId: null };
    const result = await applyEmailUnsubscribe(email, "Unsubscribe: {{unsend_unsubscribe_url}}");
    expect(result?.unsubscribed).toBe(false);
    if (!result || result.unsubscribed) throw new Error("expected links");
    expect(result.html).toContain('href="https://send.example/unsubscribe/email?id=1.');
    expect(result.text).toContain("https://send.example/unsubscribe/email?id=1.");
    expect(result.unsubUrl).toContain("/api/unsubscribe-email-oneclick?");
  });

  it("stops the send for an unsubscribed recipient", async () => {
    mockDb.suppressionList.findUnique.mockResolvedValue({ reason: "UNSUBSCRIBE" });
    const email = { teamId: 1, to: ["a@b.co"], html: "{{usesend_unsubscribe_url}}", campaignId: null };
    expect(await applyEmailUnsubscribe(email, undefined)).toEqual({ unsubscribed: true });
  });

  it("refuses the placeholder with more than one recipient", async () => {
    const email = { teamId: 1, to: ["a@b.co", "c@d.co"], html: "{{usesend_unsubscribe_url}}", campaignId: null };
    await expect(applyEmailUnsubscribe(email, undefined)).rejects.toThrow("exactly one recipient");
  });

  it("never downgrades an existing bounce or complaint", async () => {
    await unsubscribeEmail(1, "A@b.co", "one-click");
    expect(mockDb.suppressionList.upsert).toHaveBeenCalledWith({
      where: { teamId_email: { teamId: 1, email: "a@b.co" } },
      create: { teamId: 1, email: "a@b.co", reason: "UNSUBSCRIBE", source: "one-click" },
      update: {},
    });
  });
});
