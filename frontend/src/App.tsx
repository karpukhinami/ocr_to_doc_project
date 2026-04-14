import { useCallback, useMemo, useState } from "react";
import "./App.css";

const API = "/api";

type ItemKind = "image" | "text" | "docx";

interface FigureInfo {
  index: number;
  filename: string;
  base64: string;
}

interface DocItem {
  id: string;
  kind: ItemKind;
  file: File;
  previewUrl?: string;
  processed: boolean;
  markdown?: string;
  figures?: FigureInfo[];
  error?: string;
  textContent?: string;
  /** Уже попало в последний экспорт docx/md */
  docxIncluded: boolean;
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

function kindFromFile(f: File): ItemKind | null {
  const e = extOf(f.name);
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(e)) return "image";
  if (["txt", "md"].includes(e)) return "text";
  if (e === "docx") return "docx";
  return null;
}

function rewriteFigurePaths(md: string, itemId: string): string {
  return md.replace(/media\/fig_(\d+)\.png/g, `media/${itemId}_fig_$1.png`);
}

function base64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: "image/png" });
}

export default function App() {
  const [items, setItems] = useState<DocItem[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [totalJobs, setTotalJobs] = useState(0);
  const [modal, setModal] = useState<"docx" | "md" | null>(null);
  const [hasExportedOnce, setHasExportedOnce] = useState(false);

  const revokePreview = useCallback((it: DocItem) => {
    if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
  }, []);

  const addFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const arr = Array.from(fileList);
      const next: DocItem[] = [];
      for (const file of arr) {
        const kind = kindFromFile(file);
        if (!kind) continue;
        const id = newId();
        if (kind === "image") {
          next.push({
            id,
            kind,
            file,
            previewUrl: URL.createObjectURL(file),
            processed: false,
            docxIncluded: false,
          });
        } else if (kind === "text") {
          const text = await file.text();
          next.push({
            id,
            kind,
            file,
            processed: true,
            textContent: text,
            docxIncluded: false,
          });
        } else {
          next.push({
            id,
            kind,
            file,
            processed: false,
            docxIncluded: false,
          });
        }
      }
      setItems((prev) => [...prev, ...next]);
    },
    []
  );

  /** Возвращает список с заполненным textContent для .docx (без гонки с setState). */
  const extractDocxTexts = useCallback(async (list: DocItem[]): Promise<DocItem[]> => {
    let out = [...list];
    const need = out.filter((i) => i.kind === "docx" && i.textContent === undefined);
    for (const it of need) {
      const fd = new FormData();
      fd.append("file", it.file);
      const r = await fetch(`${API}/extract-docx-text`, { method: "POST", body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error((err as { detail?: string }).detail || r.statusText);
      }
      const data = (await r.json()) as { text: string };
      out = out.map((x) =>
        x.id === it.id ? { ...x, textContent: data.text, processed: true } : x
      );
    }
    setItems(out);
    return out;
  }, []);

  const removeItem = (id: string) => {
    setItems((prev) => {
      const t = prev.find((x) => x.id === id);
      if (t) revokePreview(t);
      return prev.filter((x) => x.id !== id);
    });
  };

  const recognize = async () => {
    const targets = items.filter((i) => i.kind === "image" && !i.processed);
    if (targets.length === 0) return;
    setBusy(true);
    setTotalJobs(targets.length);
    setProgress(0);
    let done = 0;
    for (const it of targets) {
      const fd = new FormData();
      fd.append("file", it.file);
      try {
        const r = await fetch(`${API}/process-image`, { method: "POST", body: fd });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error((data as { detail?: string }).detail || r.statusText);
        }
        const payload = data as {
          markdown: string;
          figures: FigureInfo[];
        };
        setItems((prev) =>
          prev.map((x) =>
            x.id === it.id
              ? {
                  ...x,
                  processed: true,
                  markdown: payload.markdown,
                  figures: payload.figures,
                  error: undefined,
                }
              : x
          )
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setItems((prev) =>
          prev.map((x) => (x.id === it.id ? { ...x, error: msg, processed: false } : x))
        );
      }
      done += 1;
      setProgress(done);
    }
    setBusy(false);
  };

  const buildSections = (
    list: DocItem[],
    onlyNew: boolean
  ): { markdown: string; blobs: { name: string; blob: Blob }[] } => {
    const blobs: { name: string; blob: Blob }[] = [];
    const parts: string[] = [];
    let shot = 0;

    for (const it of list) {
      if (onlyNew && it.docxIncluded) continue;

      if (it.kind === "image") {
        if (!it.markdown) continue;
        shot += 1;
        parts.push(`\n\n========= скриншот ${shot} =========\n\n`);
        const md = rewriteFigurePaths(it.markdown, it.id);
        parts.push(md);
        if (it.figures) {
          for (const f of it.figures) {
            const name = `${it.id}_fig_${f.index}.png`;
            blobs.push({ name, blob: base64ToBlob(f.base64) });
          }
        }
      } else if (it.kind === "text" && it.textContent !== undefined) {
        parts.push(`\n\n========= файл: ${it.file.name} =========\n\n`);
        parts.push(it.textContent);
      } else if (it.kind === "docx" && it.textContent !== undefined) {
        parts.push(`\n\n========= файл: ${it.file.name} =========\n\n`);
        parts.push(it.textContent);
      }
    }

    return { markdown: parts.join("").trim() + "\n", blobs };
  };

  const runDocxExport = async (onlyNew: boolean) => {
    const fresh = await extractDocxTexts(items);
    const { markdown, blobs } = buildSections(fresh, onlyNew);
    if (!markdown.trim()) {
      alert("Нет содержимого для сохранения.");
      return;
    }
    const fd = new FormData();
    fd.append("markdown", markdown);
    for (const b of blobs) {
      fd.append("files", b.blob, b.name);
    }
    const r = await fetch(`${API}/convert-docx`, { method: "POST", body: fd });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(t || r.statusText);
    }
    const buf = await r.arrayBuffer();
    const blob = new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "document.docx";
    a.click();
    URL.revokeObjectURL(a.href);

    setItems((prev) =>
      prev.map((x) => {
        if (onlyNew) {
          if (!x.docxIncluded && (x.markdown || x.textContent)) return { ...x, docxIncluded: true };
          return x;
        }
        return { ...x, docxIncluded: true };
      })
    );
    setHasExportedOnce(true);
  };

  const runMdExport = async (onlyNew: boolean) => {
    const fresh = await extractDocxTexts(items);
    const { markdown } = buildSections(fresh, onlyNew);
    if (!markdown.trim()) {
      alert("Нет содержимого для сохранения.");
      return;
    }
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "document.md";
    a.click();
    URL.revokeObjectURL(a.href);

    setItems((prev) =>
      prev.map((x) => {
        if (onlyNew) {
          if (!x.docxIncluded && (x.markdown || x.textContent)) return { ...x, docxIncluded: true };
          return x;
        }
        return { ...x, docxIncluded: true };
      })
    );
    setHasExportedOnce(true);
  };

  const onSaveDocx = async () => {
    if (hasExportedOnce) {
      setModal("docx");
      return;
    }
    setBusy(true);
    try {
      await runDocxExport(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSaveMd = () => {
    if (hasExportedOnce) {
      setModal("md");
      return;
    }
    void runMdExport(false).catch((e) => alert(String(e)));
  };

  const pendingImages = useMemo(
    () => items.filter((i) => i.kind === "image" && !i.processed).length,
    [items]
  );

  const clearAll = () => {
    items.forEach(revokePreview);
    setItems([]);
    setHasExportedOnce(false);
    setProgress(0);
    setTotalJobs(0);
  };

  return (
    <div className="app">
      <h1>OCR → Markdown → Word</h1>
      <p className="sub">
        Загрузите скриншоты и текстовые файлы. Распознавание — только для изображений. Экспорт в{" "}
        <code>.docx</code> через Pandoc на сервере.
      </p>

      <div
        className={`dropzone ${drag ? "drag" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
        }}
      >
        <p>Перетащите файлы сюда или выберите на диске</p>
        <button type="button" className="btn btn-primary" onClick={() => document.getElementById("f")?.click()}>
          Загрузить файлы
        </button>
        <input
          id="f"
          type="file"
          multiple
          accept=".png,.jpg,.jpeg,.webp,.gif,.txt,.md,.docx"
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={busy || pendingImages === 0} onClick={() => void recognize()}>
          Распознать
        </button>
        <button type="button" className="btn" disabled={busy || items.length === 0} onClick={() => void onSaveDocx()}>
          Сохранить DOCX
        </button>
        <button type="button" className="btn" disabled={items.length === 0} onClick={() => onSaveMd()}>
          Сохранить Markdown
        </button>
        <button type="button" className="btn btn-danger" onClick={clearAll}>
          Очистить всё
        </button>
      </div>

      {busy && totalJobs > 0 && (
        <div className="progress-wrap">
          <label>Распознавание: {progress} / {totalJobs}</label>
          <progress value={progress} max={totalJobs} />
        </div>
      )}

      <div className="file-list">
        {items.map((it) => (
          <div key={it.id} className="file-row">
            {it.kind === "image" && it.previewUrl ? (
              <img className="preview" src={it.previewUrl} alt="" />
            ) : (
              <span style={{ fontSize: "2rem" }} aria-hidden>
                {it.kind === "docx" ? "📄" : "📃"}
              </span>
            )}
            <div className="file-meta">
              <div className="name">{it.file.name}</div>
              <div className="status">
                {it.kind === "image" &&
                  (it.processed ? "Распознано" : "Новое изображение")}
                {it.kind === "text" && "Текст"}
                {it.kind === "docx" && (it.textContent !== undefined ? "Текст извлечён" : "Ожидает извлечения")}
                {it.error && ` — Ошибка: ${it.error}`}
              </div>
            </div>
            <button type="button" className="btn" onClick={() => removeItem(it.id)}>
              Удалить
            </button>
          </div>
        ))}
      </div>

      {modal && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => e.target === e.currentTarget && setModal(null)}
        >
          <div className="modal">
            <h3>Сохранить всё или только новое?</h3>
            <p style={{ margin: 0, fontSize: "0.9rem", color: "#444" }}>
              «Только новое» — контент, который ещё не попадал в предыдущий экспорт.
            </p>
            <div className="actions">
              <button type="button" className="btn" onClick={() => setModal(null)}>
                Отмена
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setModal(null);
                  if (modal === "docx") {
                    setBusy(true);
                    void runDocxExport(true)
                      .catch((e) => alert(String(e)))
                      .finally(() => setBusy(false));
                  } else void runMdExport(true).catch((e) => alert(String(e)));
                }}
              >
                Только новое
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setModal(null);
                  if (modal === "docx") {
                    setBusy(true);
                    void runDocxExport(false)
                      .catch((e) => alert(String(e)))
                      .finally(() => setBusy(false));
                  } else void runMdExport(false).catch((e) => alert(String(e)));
                }}
              >
                Всё
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
