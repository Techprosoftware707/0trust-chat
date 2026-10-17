export {};
interface Source {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string;
}
interface PickerApi {
  sources(): Promise<{ sources: Source[]; audioSupported: boolean; screenPermission: string }>;
  choose(id: string | null, audio: boolean): void;
  openPrivacySettings(): void;
}
const api = (window as unknown as { lumenPicker: PickerApi }).lumenPicker;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let selected: string | null = null;

function select(id: string) {
  selected = id;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".source")) b.setAttribute("aria-pressed", String(b.dataset.id === id));
  $<HTMLButtonElement>("share").disabled = false;
}

function tile(s: Source): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "source";
  b.dataset.id = s.id;
  b.setAttribute("aria-pressed", "false");
  if (s.thumbnail.startsWith("data:image/")) {
    const img = document.createElement("img");
    img.src = s.thumbnail;
    img.alt = "";
    b.append(img);
  } else {
    const d = document.createElement("div");
    d.className = "thumb-empty";
    b.append(d);
  }
  const label = document.createElement("span");
  label.textContent = s.name || (s.kind === "screen" ? "Screen" : "Window");
  b.append(label);
  b.addEventListener("click", () => select(s.id));
  b.addEventListener("dblclick", () => {
    select(s.id);
    share();
  });
  return b;
}

function share() {
  if (selected) api.choose(selected, $<HTMLInputElement>("audio").checked);
}

$("share").addEventListener("click", share);
$("cancel").addEventListener("click", () => api.choose(null, false));
$("open-privacy").addEventListener("click", () => api.openPrivacySettings());
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api.choose(null, false);
});

void api.sources().then((info) => {
  const screens = info.sources.filter((s) => s.kind === "screen");
  const windows = info.sources.filter((s) => s.kind === "window");
  $("screens").append(...screens.map(tile));
  $("windows").append(...windows.map(tile));
  $("empty").hidden = info.sources.length > 0;
  // no empty sections: a heading only above something to choose
  $("screens-h").hidden = $("screens").hidden = screens.length === 0;
  $("windows-h").hidden = $("windows").hidden = windows.length === 0;
  $("audio-row").hidden = !info.audioSupported;
  $("perm").hidden = info.screenPermission === "granted" || info.screenPermission === "not-determined";
  if (screens.length === 1 && windows.length === 0) select(screens[0]!.id);
});
