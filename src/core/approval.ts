// What an approval prompt shows of the code or command it authorizes.
//
// A prompt that shows part of what it authorizes is not an approval of what runs.
// A command must fit whole in the prompt, or it is refused; code (whose whole text
// is open in MKMN) is shown whole when it fits and otherwise says plainly how much
// is shown and that approving runs ALL of it.

export const APPROVAL_SHOWN = 3000;

export type ApprovalBody = { ok: true; text: string } | { ok: false; reason: string };

export function approvalBody(kind: "code" | "command", body: string, limit = APPROVAL_SHOWN): ApprovalBody {
  if (body.length <= limit) return { ok: true, text: body };
  if (kind === "command") {
    return { ok: false, reason: `This command is ${body.length.toLocaleString("en-US")} characters long: too long to show whole in the approval, so it is not run. Put it in a script file and run that instead.` };
  }
  return {
    ok: true,
    text: `${body.slice(0, limit)}\n\n[Shown: the first ${limit.toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")} characters. Approving runs ALL of it: read the whole code in MKMN first.]`,
  };
}
