import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addAccount, apiError, FakeDaemon, makeEnv, run, socketPath, STATUS, type Env } from "./helpers.js";

let env: Env;
let fake: FakeDaemon;

beforeEach(async () => {
  env = makeEnv();
  addAccount(env, "example");
  fake = new FakeDaemon();
  await fake.listen(socketPath(env, "example"));
});

afterEach(async () => {
  await fake.close();
  await env.cleanup();
});

const ME = { id: "100000000000000@lid", lid: "100000000000000@lid", pn: "+15550100000", name: "", me: true, operator: false };

describe("auth link", () => {
  it("prints the pairing code and where to type it, then the result", async () => {
    fake.route("POST /v1/link", () => ({ lines: [{ code: "ABCD-EFGH" }, { result: { linked: true, state: "connected", me: ME } }], end: true }));
    const r = await run(["auth", "link", "--phone", "+15550100000"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("code: ABCD-EFGH");
    expect(r.out).toContain("Link with phone number instead");
    expect(r.out).toContain("linked: true");
    expect(r.out).toContain("state: connected");
    expect(r.out).toContain("phone: +15550100000");
    const seen = fake.seen.find((s) => s.path === "/v1/link");
    expect(seen?.method).toBe("POST");
    expect(seen?.body).toEqual({ phone: "+15550100000" });
    // The code is printed before the result.
    expect(r.out.indexOf("ABCD-EFGH")).toBeLessThan(r.out.indexOf("linked: true"));
  });

  it("renders each QR code and prints its raw string", async () => {
    fake.route("POST /v1/link", () => ({ lines: [{ qr: "2@first-code" }, { qr: "2@second-code" }, { result: { linked: true, state: "connected", me: ME } }], end: true }));
    const r = await run(["auth", "link", "--qr"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("qr: 2@first-code");
    expect(r.out).toContain("qr: 2@second-code");
    expect(r.out).toMatch(/[█▀▄]/);
    expect(fake.seen.find((s) => s.path === "/v1/link")?.body).toEqual({ qr: true });
  });

  it("refuses a pairing by a different number with its own code", async () => {
    fake.route("POST /v1/link", () => ({
      lines: [{ code: "ABCD-EFGH" }, { result: { linked: false, state: "unlinked", error: { code: "wrong_number", message: "The phone that completed the link is not the number given to auth link, so the pairing was refused." } } }],
      end: true,
    }));
    const r = await run(["auth", "link", "--phone", "+15550100000"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: wrong_number");
    expect(r.out).toContain("pairing was refused");
    expect(r.out).toContain("help");
  });

  it("reports a closed window with the command to try again", async () => {
    fake.route("POST /v1/link", () => ({ lines: [{ code: "ABCD-EFGH" }, { result: { linked: false, state: "unlinked", error: { code: "link_timeout", message: "The link window closed before the phone completed the link." } } }], end: true }));
    const r = await run(["auth", "link", "--phone", "+15550100000"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: link_timeout");
    expect(r.out).toContain("whatsapp-axi auth link --phone +15550100000");
  });

  it("passes on the daemon's refusals before the stream starts", async () => {
    fake.route("POST /v1/link", () => apiError(409, "link_in_progress", "A link attempt is already running for this account.", { state: "linking" }));
    let r = await run(["auth", "link", "--qr"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: link_in_progress");
    expect(r.out).toContain("Wait for the running link attempt");
    fake.route("POST /v1/link", () => apiError(400, "bad_request", "The account is already linked (state connected). Run auth logout first to link it again.", { state: "connected" }));
    r = await run(["auth", "link", "--qr"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("already linked");
  });

  it("fails on a stream that ends without a result, or an unreadable line", async () => {
    fake.route("POST /v1/link", () => ({ lines: [{ code: "ABCD-EFGH" }], end: true }));
    let r = await run(["auth", "link", "--phone", "+15550100000"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: stream_closed");
    fake.route("POST /v1/link", () => ({ lines: [{ what: 1 }], end: true }));
    r = await run(["auth", "link", "--phone", "+15550100000"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: bad_response");
  });

  it("validates its flags before calling the daemon", async () => {
    for (const args of [[], ["--phone", "+15550100000", "--qr"], ["--phone", "15550100000"], ["--phone"], ["--nope"]]) {
      const r = await run(["auth", "link", ...args]);
      expect(r.code, `${args.join(" ")}: ${r.out}`).toBe(2);
    }
    expect(fake.seen.filter((s) => s.path === "/v1/link")).toHaveLength(0);
  });

  it("names the start command when the daemon is down", async () => {
    await fake.close();
    const r = await run(["auth", "link", "--qr"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("daemon_not_running");
  });
});

describe("auth logout", () => {
  it("needs --confirm, then logs out", async () => {
    let r = await run(["auth", "logout"]);
    expect(r.code).toBe(2);
    fake.route("POST /v1/logout", () => ({ body: { logged_out: true, state: "unlinked" } }));
    r = await run(["auth", "logout", "--confirm"]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("logged_out: true");
    expect(r.out).toContain("auth link");
  });

  it("is a no-op when already unlinked", async () => {
    fake.route("POST /v1/logout", () => apiError(409, "not_linked", "Logging out needs a linked account; this one has no session (state unlinked).", { state: "unlinked" }));
    const r = await run(["auth", "logout", "--confirm"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("already unlinked (no-op)");
  });

  it("passes on not_connected and WhatsApp errors", async () => {
    fake.route("POST /v1/logout", () => apiError(409, "not_connected", "Logging out needs a live connection to WhatsApp; the account is connecting.", { state: "connecting" }));
    let r = await run(["auth", "logout", "--confirm"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: not_connected");
    expect(r.out).toContain("doctor");
    fake.route("POST /v1/logout", () => apiError(502, "whatsapp_error", "WhatsApp did not accept the logout; the device is still linked."));
    r = await run(["auth", "logout", "--confirm"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("code: whatsapp_error");
  });
});

describe("doctor link and state checks", () => {
  it("reports the link", async () => {
    const r = await run(["doctor"]);
    expect(r.out).toContain("example,link,ok,linked as +15550100000");
  });

  it("names auth link for an unlinked account", async () => {
    fake.route("GET /v1/status", () => ({ body: { ...STATUS, state: "unlinked", reason: "no session", me: null, last_phone_activity: null } }));
    const r = await run(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("example,link,fail,not linked to WhatsApp");
    expect(r.out).toContain("whatsapp-axi auth link --phone <number> --account example");
  });

  it("says what happened and what to do for each stopped state", async () => {
    const cases: Record<string, string> = {
      logged_out: "auth link --phone <number>",
      outdated: "whatsapp-axi daemon upgrade",
      suspended: "wait for the expiry",
    };
    for (const [state, fix] of Object.entries(cases)) {
      fake.route("GET /v1/status", () => ({ body: { ...STATUS, state, reason: `reason of ${state}`, me: state === "logged_out" ? null : STATUS.me } }));
      const r = await run(["doctor"]);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`example,state,fail,"${state} since`);
      expect(r.out).toContain(`reason of ${state}`);
      expect(r.out).toContain(fix);
    }
  });
});
