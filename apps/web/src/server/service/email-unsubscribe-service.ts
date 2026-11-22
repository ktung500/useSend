import { createHash, timingSafeEqual } from "crypto";
import type { Email } from "@prisma/client";
import { env } from "~/env";
import { db } from "../db";

/**
 * Unsubscribe links for API emails (campaigns have their own, tied to a contact book).
 * An API email opts in by putting {{usesend_unsubscribe_url}} in its html or text. At send
 * time the placeholder becomes this recipient's signed link and the one-click
 * List-Unsubscribe headers are added. Unsubscribing adds an UNSUBSCRIBE suppression, which
 * only blocks later emails that carry the placeholder, so receipts and password resets
 * still go out. Suppressions are per team: put apps that need separate lists in separate teams.
 */

const PLACEHOLDER = /\{\{\s*(?:usesend|unsend)_unsubscribe_url\s*\}\}/i;
const PLACEHOLDER_ALL = new RegExp(PLACEHOLDER.source, "gi");
const INVALID = "Invalid unsubscribe link";

const normalize = (email: string) => email.toLowerCase().trim();

function sign(id: string) {
  return createHash("sha256")
    .update(`email-unsub:${id}-${env.NEXTAUTH_SECRET}`)
    .digest("hex");
}

export function createEmailUnsubUrls(teamId: number, email: string) {
  const id = `${teamId}.${Buffer.from(normalize(email)).toString("base64url")}`;
  const query = `id=${id}&hash=${sign(id)}`;
  return {
    pageUrl: `${env.NEXTAUTH_URL}/unsubscribe/email?${query}`,
    oneClickUrl: `${env.NEXTAUTH_URL}/api/unsubscribe-email-oneclick?${query}`,
  };
}

export function verifyEmailUnsubLink(id: string, hash: string) {
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(hash);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error(INVALID);
  }
  const [team, encoded] = id.split(".");
  const teamId = Number(team);
  if (!Number.isInteger(teamId) || !encoded) throw new Error(INVALID);
  return { teamId, email: Buffer.from(encoded, "base64url").toString() };
}

export function hasUnsubscribePlaceholder(
  ...sources: Array<string | null | undefined>
) {
  return sources.some((source) => !!source && PLACEHOLDER.test(source));
}

export function fillUnsubscribePlaceholder<T extends string | null | undefined>(
  source: T,
  url: string,
): T {
  return (source ? source.replace(PLACEHOLDER_ALL, url) : source) as T;
}

export async function isEmailUnsubscribed(teamId: number, email: string) {
  const suppression = await db.suppressionList.findUnique({
    where: { teamId_email: { teamId, email: normalize(email) } },
    select: { reason: true },
  });
  return suppression?.reason === "UNSUBSCRIBE";
}

export async function unsubscribeEmail(
  teamId: number,
  email: string,
  source?: string,
) {
  // Create only: an existing bounce or complaint entry is stricter and must stay.
  await db.suppressionList.upsert({
    where: { teamId_email: { teamId, email: normalize(email) } },
    create: { teamId, email: normalize(email), reason: "UNSUBSCRIBE", source },
    update: {},
  });
}

/**
 * Called by the send worker. null: not an unsubscribable API email, send as is.
 * { unsubscribed: true }: the recipient opted out, don't send.
 */
export async function applyEmailUnsubscribe(
  email: Pick<Email, "teamId" | "to" | "html" | "campaignId">,
  text: string | undefined,
) {
  if (email.campaignId || !hasUnsubscribePlaceholder(email.html, text)) {
    return null;
  }
  const [recipient, ...others] = email.to;
  if (!recipient || others.length > 0) {
    throw new Error(
      "{{usesend_unsubscribe_url}} needs exactly one recipient in `to`",
    );
  }
  if (await isEmailUnsubscribed(email.teamId, recipient)) {
    return { unsubscribed: true as const };
  }
  const { pageUrl, oneClickUrl } = createEmailUnsubUrls(email.teamId, recipient);
  return {
    unsubscribed: false as const,
    html: fillUnsubscribePlaceholder(email.html, pageUrl),
    text: fillUnsubscribePlaceholder(text, pageUrl),
    unsubUrl: oneClickUrl,
  };
}
