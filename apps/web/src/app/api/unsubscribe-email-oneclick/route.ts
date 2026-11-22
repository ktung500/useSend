import { NextRequest, NextResponse } from "next/server";
import {
  unsubscribeEmail,
  verifyEmailUnsubLink,
} from "~/server/service/email-unsubscribe-service";
import { logger } from "~/server/logger/log";

// Fork: RFC 8058 one-click unsubscribe (List-Unsubscribe-Post) for API emails.
export async function POST(request: NextRequest) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") ?? "";
  const hash = url.searchParams.get("hash") ?? "";

  let link;
  try {
    link = verifyEmailUnsubLink(id, hash);
  } catch {
    return NextResponse.json({ error: "Invalid unsubscribe link" }, { status: 400 });
  }

  try {
    await unsubscribeEmail(link.teamId, link.email, "one-click");
    logger.info({ teamId: link.teamId }, "One-click email unsubscribe successful");
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : error },
      "One-click email unsubscribe failed",
    );
    return NextResponse.json({ error: "Failed to unsubscribe" }, { status: 500 });
  }
}
