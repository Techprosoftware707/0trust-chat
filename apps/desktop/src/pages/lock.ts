export {};
interface LockApi {
  state(): Promise<{ brand: string; touchId: boolean; retryAfterMs: number }>;
  unlock(pin: string): Promise<{ ok: boolean; retryAfterMs: number; error?: string }>;
  touchId(): Promise<{ ok: boolean; error?: string }>;
}
const api = (window as unknown as { lumenLock: LockApi }).lumenLock;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pin = $<HTMLInputElement>("pin");
const error = $("error");
const unlockBtn = $<HTMLButtonElement>("unlock");
let blockedTimer: number | null = null;

function showError(msg: string | null) {
  error.hidden = !msg;
  error.textContent = msg ?? "";
}

function blockFor(ms: number, msg: string) {
  if (ms <= 0) return;
  unlockBtn.disabled = true;
  const until = Date.now() + ms;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      unlockBtn.disabled = false;
      showError(null);
      if (blockedTimer) window.clearInterval(blockedTimer);
      blockedTimer = null;
      return;
    }
    showError(`${msg} Try again in ${left} s.`);
  };
  tick();
  if (blockedTimer) window.clearInterval(blockedTimer);
  blockedTimer = window.setInterval(tick, 1000);
}

$<HTMLFormElement>("form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!pin.value) return;
  unlockBtn.disabled = true;
  void api.unlock(pin.value).then((r) => {
    pin.value = "";
    unlockBtn.disabled = false;
    if (r.ok) return;
    if (r.retryAfterMs > 0) blockFor(r.retryAfterMs, r.error ?? "Too many attempts.");
    else showError(r.error ?? "Wrong PIN.");
    pin.focus();
  });
});

$("touchid").addEventListener("click", () => {
  void api.touchId().then((r) => {
    if (!r.ok) showError(r.error ?? "Touch ID failed.");
  });
});

void api.state().then((s) => {
  $("title").textContent = `${s.brand} is locked`;
  document.title = `${s.brand} — locked`;
  if (s.touchId) {
    $("touchid").hidden = false;
    void api.touchId();
  }
  if (s.retryAfterMs > 0) blockFor(s.retryAfterMs, "Too many wrong PINs.");
  pin.focus();
});
