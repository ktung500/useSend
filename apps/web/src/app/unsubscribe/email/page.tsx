import { redirect } from "next/navigation";
import {
  isEmailUnsubscribed,
  unsubscribeEmail,
  verifyEmailUnsubLink,
} from "~/server/service/email-unsubscribe-service";
import UnsubscribeButton from "../unsubscribe-button";

// Fork: confirm page for {{usesend_unsubscribe_url}} in API emails. A button, not a GET
// unsubscribe, so link scanners in mail filters can't opt people out.

export const dynamic = "force-dynamic";

function readLink(id: unknown, hash: unknown) {
  if (typeof id !== "string" || typeof hash !== "string") return null;
  try {
    return verifyEmailUnsubLink(id, hash);
  } catch {
    return null;
  }
}

async function unsubscribeAction(formData: FormData) {
  "use server";

  const id = formData.get("id");
  const hash = formData.get("hash");
  const link = readLink(id, hash);
  if (link) await unsubscribeEmail(link.teamId, link.email, "unsubscribe-page");
  redirect(
    `/unsubscribe/email?${new URLSearchParams({ id: String(id ?? ""), hash: String(hash ?? "") })}`,
  );
}

function Card({ title, message }: { title: string; message: string }) {
  return (
    <div className="w-full max-w-md space-y-4 rounded-xl border p-8 shadow">
      <h1 className="text-center text-2xl font-semibold">{title}</h1>
      <p className="text-center text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

export default async function EmailUnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const hash = Array.isArray(params.hash) ? params.hash[0] : params.hash;
  const link = readLink(id, hash);

  let content;
  if (!link) {
    content = (
      <Card
        title="Invalid link"
        message="Check the URL and try again."
      />
    );
  } else if (await isEmailUnsubscribed(link.teamId, link.email)) {
    content = (
      <Card
        title="You're unsubscribed"
        message={`${link.email} won't get these emails anymore.`}
      />
    );
  } else {
    content = (
      <div className="w-full max-w-md space-y-6 rounded-xl border p-8 shadow">
        <div className="space-y-2">
          <h1 className="text-center text-2xl font-semibold">Unsubscribe</h1>
          <p className="text-center text-sm text-muted-foreground">
            Stop these emails to{" "}
            <span className="font-medium text-foreground">{link.email}</span>?
          </p>
        </div>
        <form action={unsubscribeAction}>
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="hash" value={hash} />
          <UnsubscribeButton />
        </form>
      </div>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      {content}
    </main>
  );
}
