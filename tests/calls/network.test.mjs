/**
 * Call behaviour under real network impairment, applied with tc/netem and iptables inside
 * each client's own network namespace (tests/calls/lab.sh). Two clients: A (lab-a, 440 Hz)
 * and B (lab-b, 660 Hz) in a 1:1 video call through the deployed SFU.
 *
 *   sudo NODE_EXTRA_CA_CERTS=/etc/lumen/ca/caddy-local-root.crt node tests/calls/network.test.mjs
 *
 * 9  bandwidth limit on A's uplink → encoder limited by bandwidth, fewer/lower simulcast
 *    layers, B receives a lower resolution, audio continues; recovery after the limit is lifted
 * 10 10 % packet loss on B's uplink → voice continues, loss/concealment/FEC numbers
 * 15 TURN: no direct media path (all UDP but TURN/UDP 3478, and ICE/TCP 7881 blocked) → relay over TURN/UDP;
 *    all UDP blocked → ICE/TCP; all UDP and ICE/TCP blocked → no path: Lumen offers no TURN/TLS
 *    (LiveKit 1.13 advertises it only on :443, which is Caddy's), so the call must fail visibly
 * 16 link down for ~5 s → reconnecting state shown → media resumes
 */
import assert from "node:assert/strict";
import path from "node:path";
import { acceptIncoming, expectTone, hangUpAll, leave, startFromHeader, waitE2EE } from "./lib/callui.mjs";
import { createDm, ensureLab, hearRemoteTones, icePairs, lab, launchClient, makeReporter, NO_NETNS, openRoom, rtcStats, sampleRates, selectedPairs, SHOTS, signIn, T } from "./lib/lab.mjs";

const rep = makeReporter("network");
const { log, step } = rep;
const shot = (c, name) => c.page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

if (NO_NETNS) {
  for (const t of ["9 bandwidth limit", "10 packet loss", "15 TURN relay / TCP / TLS", "16 link outage recovery"]) rep.skip(t, "needs per-client network namespaces (--no-netns given)");
  rep.finish();
  process.exit(0);
}

log(`lab: ${ensureLab().replace(/\n/g, " | ")}`);
const A = await launchClient({ ns: "lab-a", label: "A", tone: 440 });
const B = await launchClient({ ns: "lab-b", label: "B", tone: 660 });
rep.failShots(A, B);
let dm = "";

/** Undo any impairment a failed step may have left behind. */
function resetNet() {
  for (const ns of ["lab-a", "lab-b"]) {
    lab("unshape", ns);
    lab("unblock-all", ns);
    lab("link", ns, "up");
  }
}

const fmt = (rows) => rows.map((r) => `${r.dir} ${r.kind}${r.rid ? `/${r.rid}` : ""} ${r.frameWidth ? `${r.frameWidth}x${r.frameHeight}@${r.framesPerSecond ?? "?"} ` : ""}${r.kbps} kbit/s${r.qualityLimitationReason ? ` limit=${r.qualityLimitationReason}` : ""}${r.dLost ? ` lost+${r.dLost}` : ""}`);

async function videoCall() {
  await startFromHeader(A, "video");
  await acceptIncoming(B, "video");
  await waitE2EE(A);
  await waitE2EE(B);
  await B.page.waitForTimeout(6000);
}

async function pathOf(client) {
  const pairs = selectedPairs(await rtcStats(client)).filter((p) => p.state === "succeeded");
  return pairs.map((p) => `${p.localType}/${p.localProtocol}${p.relayProtocol ? ` via ${p.relayProtocol}` : ""} → ${p.remoteType}/${p.remoteProtocol} :${p.remotePort} rtt=${p.rtt}`);
}

try {
  await step("sign in A and B; open their DM", { always: true }, async () => {
    await signIn(A, "alice", "Alice Lumen");
    await signIn(B, "bob", "Bob Lumen");
    dm = await createDm(A, B);
    await openRoom(A, dm);
    await openRoom(B, dm);
  });

  await step("9: 300 kbit/s + 50 ms on A's uplink → bandwidth-limited, lower layer for B, audio continues; recovers after unshape", async () => {
    await hangUpAll(A, B);
    resetNet();
    await videoCall();
    const before = await sampleRates(A, 4000);
    log("A before:", fmt(before.filter((r) => r.dir === "out")));
    log(lab("shape", "lab-a", "rate", "300kbit", "delay", "50ms"));
    await A.page.waitForTimeout(20_000);
    const outA = await sampleRates(A, 5000);
    const inB = await sampleRates(B, 5000);
    log("A shaped (out):", fmt(outA.filter((r) => r.dir === "out")));
    log("B while A shaped (in):", fmt(inB.filter((r) => r.dir === "in")));
    const vOut = outA.filter((r) => r.dir === "out" && r.kind === "video");
    const sentKbps = vOut.reduce((a, r) => a + (r.kbps ?? 0), 0);
    assert.ok(sentKbps < 300, `video sent ${sentKbps} kbit/s fits the 300 kbit/s link`);
    assert.ok(vOut.some((r) => r.qualityLimitationReason === "bandwidth") || vOut.filter((r) => (r.kbps ?? 0) > 5).length < 3, "encoder reports bandwidth limitation or drops layers");
    const vIn = inB.find((r) => r.dir === "in" && r.kind === "video");
    log(`B receives ${vIn?.frameWidth}x${vIn?.frameHeight} (was 720p-class before)`);
    const heard = await hearRemoteTones(B);
    log("B hears while A is limited:", heard);
    expectTone(heard, A.userId, 440, "audio continues under the bandwidth limit");
    await B.page.locator('[data-testid="call-status"]').waitFor();
    await shot(A, "desktop-light-bandwidth-limited");
    log(lab("unshape", "lab-a"));
    let rec = null;
    for (let i = 0; i < 12; i++) {
      await B.page.waitForTimeout(5000);
      const r = (await sampleRates(B, 3000)).find((x) => x.dir === "in" && x.kind === "video");
      log(`recovery +${(i + 1) * 8}s: B receives ${r?.frameWidth}x${r?.frameHeight}@${r?.framesPerSecond} ${r?.kbps} kbit/s`);
      if (r && r.frameHeight >= 540) {
        rec = r;
        break;
      }
    }
    assert.ok(rec, "B is back to ≥ 540p after the limit is lifted");
    await leave(A);
    await B.page.locator(".call-screen").waitFor({ state: "detached", timeout: T });
  });

  await step("10: 10 % packet loss on B's uplink: voice continues; loss, concealment and FEC from A's inbound-rtp", async () => {
    await hangUpAll(A, B);
    resetNet();
    await startFromHeader(A, "audio");
    await acceptIncoming(B, "audio");
    await waitE2EE(A);
    log(lab("shape", "lab-b", "loss", "10%", "delay", "30ms"));
    await A.page.waitForTimeout(8000);
    const rows = await sampleRates(A, 8000);
    const inn = rows.find((r) => r.dir === "in" && r.kind === "audio" && (r.dPackets ?? 0) > 0);
    log("A inbound audio from B under 10 % loss:", {
      packets: inn.dPackets,
      lost: inn.dLost,
      lossPct: Math.round((inn.dLost / (inn.dLost + inn.dPackets)) * 1000) / 10,
      concealedSamples: inn.dConcealed,
      totalSamples: inn.dSamples,
      concealedPct: Math.round((inn.dConcealed / inn.dSamples) * 1000) / 10,
      fecPacketsReceived: inn.fecPacketsReceived,
      jitterMs: Math.round((inn.jitter ?? 0) * 1000),
    });
    const outB = (await sampleRates(B, 6000)).find((r) => r.dir === "out" && r.kind === "audio" && (r.dPackets ?? 0) > 0);
    log("B outbound audio under its 10 % uplink loss (SFU's receiver reports, retransmissions):", {
      packetsSent: outB?.dPackets,
      retransmittedPacketsSent: outB?.retransmittedPacketsSent,
      nackCount: outB?.nackCount,
      sfuReportedLoss: outB?.remoteLoss,
    });
    log("note: Chrome counts only FlexFEC/ULPFEC in fecPacketsReceived; Opus in-band FEC recovery isn't exposed in getStats (it shows up as less concealment than loss). Audio isn't retransmitted (NACK counts above), so the uplink loss reaches A; the SFU's fractionLost is its last receiver-report interval only");
    assert.ok(inn.dLost > 0 || (outB?.remoteLoss?.packetsLost ?? 0) > 0 || (outB?.retransmittedPacketsSent ?? 0) > 0, "loss is measured (end-to-end, at the SFU, or as retransmissions)");
    const heard = await hearRemoteTones(A, 4000);
    log("A hears B under loss:", heard);
    expectTone(heard, B.userId, 660, "voice continues under 10 % loss");
    const diag = await A.page.locator('[data-testid="call-status"]').textContent();
    log(`A call status under loss: ${diag}`);
    await shot(A, "desktop-light-packet-loss");
    log(lab("unshape", "lab-b"));
    await leave(A);
    await B.page.locator(".call-screen").waitFor({ state: "detached", timeout: T });
  });

  await step("15a: no direct media path for B (all UDP except TURN/UDP 3478, and ICE/TCP 7881 blocked) → TURN relay over UDP, media flows", async () => {
    await hangUpAll(A, B);
    resetNet();
    // Blocking only the SFU's media ports isn't enough: the SFU also sends from its other host
    // addresses, which the host masquerades to random ports (peer-reflexive candidates).
    log(lab("block-udp-except", "lab-b", "3478"));
    log(lab("block-port", "lab-b", "tcp", "7881"));
    await startFromHeader(A, "audio");
    await acceptIncoming(B, "audio");
    await B.page.waitForTimeout(10_000);
    log("B's ICE candidate pairs after 10 s:", await icePairs(B));
    await waitE2EE(B, 60_000);
    await B.page.waitForTimeout(3000);
    const p = await pathOf(B);
    log("B selected ICE path(s):", p);
    assert.ok(p.some((x) => /^relay\//.test(x)), "B's media goes through a TURN relay");
    expectTone(await hearRemoteTones(B), A.userId, 440, "B hears A via TURN");
    expectTone(await hearRemoteTones(A), B.userId, 660, "A hears B via TURN");
    await B.page.locator(".call-top").getByRole("button", { name: "Call diagnostics" }).click();
    await B.page.locator('[data-testid="turn-relay"]').waitFor({ timeout: T });
    log(`B diagnostics: ${(await B.page.locator('[data-testid="turn-relay"]').textContent()).trim()}`);
    await shot(B, "desktop-light-turn-relay");
    await leave(A);
    await B.page.locator(".call-screen").waitFor({ state: "detached", timeout: T });
    log(lab("unblock-all", "lab-b"));
  });

  await step("15b: all UDP blocked for B → ICE over TCP (port 7881), media flows", async () => {
    await hangUpAll(A, B);
    resetNet();
    log(lab("block-udp", "lab-b"));
    await startFromHeader(A, "audio");
    await acceptIncoming(B, "audio");
    await B.page.waitForTimeout(10_000);
    log("B's ICE candidate pairs after 10 s:", await icePairs(B));
    await waitE2EE(B, 60_000);
    await B.page.waitForTimeout(3000);
    const p = await pathOf(B);
    log("B selected ICE path(s):", p);
    assert.ok(p.some((x) => /\/tcp/.test(x)), "B's media goes over TCP");
    expectTone(await hearRemoteTones(B), A.userId, 440, "B hears A over TCP");
    expectTone(await hearRemoteTones(A), B.userId, 660, "A hears B over TCP");
    await leave(A);
    await B.page.locator(".call-screen").waitFor({ state: "detached", timeout: T });
  });

  await step("15c: all UDP and ICE/TCP blocked for B → no media path; B is told the call could not connect", async () => {
    await hangUpAll(A, B);
    resetNet();
    log(lab("block-udp", "lab-b"));
    log(lab("block-port", "lab-b", "tcp", "7881"));
    await startFromHeader(A, "audio");
    await acceptIncoming(B, "audio");
    await B.page.waitForTimeout(10_000);
    log("B's ICE candidate pairs after 10 s:", await icePairs(B));
    // No TURN/TLS is offered (ADR 0002 D4), so B has no media path: it must never show
    // "connected", and its status must say what is happening (connecting / reconnecting /
    // an end reason) — no silent or fake call.
    const phases = new Set();
    for (let i = 0; i < 45; i++) {
      phases.add(await B.page.locator(".call-screen").getAttribute("data-phase").catch(() => "gone"));
      await B.page.waitForTimeout(1000);
    }
    const status = (await B.page.locator('[data-testid="call-status"]').innerText().catch(() => "")).trim();
    log("B's call phases over 45 s:", [...phases], "status:", status || "(call screen closed)");
    assert.ok(!phases.has("connected"), "B never reports a connected call without a media path");
    assert.ok(phases.has("connecting") || phases.has("reconnecting") || phases.has("ended") || phases.has("gone"), "B shows a non-connected state");
    if (phases.has("ended")) assert.ok(status.length > 0, "an ended call says why");
    await leave(A).catch(() => {});
    await B.page.locator(".call-screen").waitFor({ state: "detached", timeout: T }).catch(() => {});
    log(lab("unblock-all", "lab-b"));
  });

  await step("16: B's link down for ~5 s → B shows 'Reconnecting', then media resumes in both directions", async () => {
    await hangUpAll(A, B);
    resetNet();
    await startFromHeader(A, "audio");
    await acceptIncoming(B, "audio");
    await waitE2EE(B);
    await B.page.waitForTimeout(2000);
    const t0 = Date.now();
    log(lab("link", "lab-b", "down"));
    const sawReconnecting = B.page
      .locator('[data-testid="call-reconnecting"]')
      .waitFor({ timeout: 20_000 })
      .then(() => Date.now() - t0)
      .catch(() => null);
    await B.page.waitForTimeout(5000);
    log(lab("link", "lab-b", "up"));
    const shownAfter = await sawReconnecting;
    log(`'Reconnecting' banner shown on B after ${shownAfter} ms`);
    if (shownAfter !== null) await shot(B, "desktop-light-reconnecting");
    await B.page.locator('.call-screen[data-phase="connected"]').waitFor({ timeout: 60_000 });
    log(`B back to connected ${Date.now() - t0} ms after the outage began`);
    await B.page.waitForTimeout(3000);
    expectTone(await hearRemoteTones(B), A.userId, 440, "B hears A again");
    expectTone(await hearRemoteTones(A), B.userId, 660, "A hears B again");
    await B.page.locator(".call-top").getByRole("button", { name: "Call diagnostics" }).click();
    log(`B connection events: ${(await B.page.locator(".diag-events").innerText()).replace(/\n/g, " | ")}`);
    assert.ok(shownAfter !== null, "reconnecting state was shown");
    await leave(A);
  });
} finally {
  for (const ns of ["lab-a", "lab-b"]) {
    lab("unshape", ns);
    lab("unblock-all", ns);
    lab("link", ns, "up");
  }
  log(`CSP violations / page errors: ${[...A.problems, ...B.problems].length ? JSON.stringify([...A.problems, ...B.problems].slice(0, 10)) : "none"}`);
  rep.finish();
  for (const c of [A, B]) await c.browser.close().catch(() => undefined);
}
