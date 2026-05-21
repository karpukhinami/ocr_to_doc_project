import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const API = "/api";

/** $ / 1M токенов (вход / выход) — OpenRouter pricing. */
const PRICE_IN_PER_M = 0.2;
const PRICE_OUT_PER_M = 0.88;

type ItemKind = "image" | "text" | "docx";

interface FigureInfo {
  index: number;
  filename: string;
  base64: string;
}

interface UsageChunk {
  prompt_tokens?: number;
  completion_tokens?: number;
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
  /** Для изображений: участвует в «сохранить выделенное». */
  selected: boolean;
}

interface SaveDocOptions {
  saveAll: boolean;
  insertScreenshots: boolean;
  insertFigures: boolean;
  convertMarkdown: boolean;
  /** true — оставить формулы как LaTeX-текст; false — преобразовать в формулы Word (Pandoc). */
  latexFormulas: boolean;
}

const defaultSaveOptions: SaveDocOptions = {
  saveAll: true,
  insertScreenshots: true,
  insertFigures: true,
  convertMarkdown: true,
  latexFormulas: false,
};

/** Текст поля `detail` из FastAPI (строка или список ошибок валидации). */
function formatFastApiDetail(detail: unknown): string {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (item && typeof item === "object" && "msg" in item) {
          return String((item as { msg: string }).msg);
        }
        return JSON.stringify(item);
      })
      .join("; ");
  }
  if (typeof detail === "object" && "message" in (detail as object)) {
    return String((detail as { message: string }).message);
  }
  return String(detail);
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

/** Изображения из буфера обмена (Win+V / PrintScreen + Ctrl+V и т.п.). */
function filesFromClipboard(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items;
  if (!items?.length) return [];

  const out: File[] = [];
  const stamp = Date.now();
  let imageIdx = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== "file") continue;
    const mime = item.type || "";
    if (!mime.startsWith("image/")) continue;

    const blob = item.getAsFile();
    if (!blob || blob.size === 0) continue;

    const ext =
      mime === "image/png"
        ? "png"
        : mime === "image/jpeg" || mime === "image/jpg"
          ? "jpg"
          : mime === "image/webp"
            ? "webp"
            : mime === "image/gif"
              ? "gif"
              : "png";

    const hasSensibleName = blob.name && /\.(png|jpe?g|webp|gif)$/i.test(blob.name);
    const name = hasSensibleName ? blob.name : `paste-${stamp}-${imageIdx}.${ext}`;
    imageIdx += 1;

    out.push(hasSensibleName ? blob : new File([blob], name, { type: blob.type || mime }));
  }

  return out;
}

function isEditableTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (el.isContentEditable) return true;
  return el.closest("input, textarea, [contenteditable='true']") !== null;
}

/** Удаляет из ответа модели синтаксис картинок — в DOCX картинки задаёт только сборщик. */
function stripMarkdownImages(md: string): string {
  let s = md.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  s = s.replace(/<img\b[^>]*>/gi, "");
  return s.trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Разделитель по центру (HTML для Pandoc; в DOCX цвет дублируется постобработкой). */
function sepCenter(line: string): string {
  return `\n\n<p style="text-align:center;color:#7d0a8f"><strong style="color:#7d0a8f">${escapeHtml(line)}</strong></p>\n\n`;
}

/** Распознанный текст как «сырой» markdown (блок кода), чтобы Pandoc не форматировал. */
function wrapMarkdownAsLiteral(md: string): string {
  const body = md.replace(/\r\n/g, "\n");
  let n = 3;
  let fence = "`".repeat(n);
  while (body.includes(fence)) {
    n += 1;
    fence = "`".repeat(n);
  }
  return `\n\n${fence}text\n${body}\n${fence}\n\n`;
}

/** Блок кода с динамической длиной ограждения, чтобы содержимое не «сломало» fence. */
function fenceBlock(body: string): string {
  let n = 3;
  let fence = "`".repeat(n);
  while (body.includes(fence)) {
    n += 1;
    fence = "`".repeat(n);
  }
  return `\n\n${fence}\n${body}\n${fence}\n\n`;
}

/** Инлайн-код с динамическими backticks (Pandoc воспринимает как литерал). */
function inlineCodeFrom(content: string): string {
  let n = 1;
  let fence = "`".repeat(n);
  while (content.includes(fence)) {
    n += 1;
    fence = "`".repeat(n);
  }
  const pad = n === 1 ? "" : " ";
  return `${fence}${pad}${content}${pad}${fence}`;
}

/**
 * Режим «LaTeX как текст» + преобразование Markdown: оборачивает $$...$$ и $...$
 * в кодовые блоки/инлайн-код, чтобы Pandoc не съедал \\, {} и т.д.
 * Внутри $$ схлопываются только лишние пустые строки.
 */
function prepareLatexSafeMarkdown(md: string): string {
  const segments = md.split(/(\$\$[\s\S]*?\$\$)/g);
  return segments
    .map((seg, idx) => {
      if (idx % 2 === 1) {
        const m = /^\$\$([\s\S]*)\$\$$/.exec(seg);
        if (!m) return seg;
        const inner = m[1].replace(/\r\n/g, "\n").replace(/\n\s*\n+/g, "\n").trim();
        return fenceBlock(`$$${inner}$$`);
      }
      return wrapInlineDollarMath(seg);
    })
    .join("");
}

function wrapInlineDollarMath(part: string): string {
  return part.replace(/(?<!\$)\$(?!\$)((?:[^$\n\\]|\\.)+?)\$(?!\$)/g, (full, inner: string) => {
    if (/^[\d\s.,]+$/.test(inner.trim())) return full;
    return inlineCodeFrom(`$${inner}$`);
  });
}

function base64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: "image/png" });
}

function singleMdDownloadName(original: string): string {
  const i = original.lastIndexOf(".");
  const base = i > 0 ? original.slice(0, i) : original;
  return `${base || "снимок"}.md`;
}

export default function App() {
  const [items, setItems] = useState<DocItem[]>([]);
  const [drag, setDrag] = useState(false);
  const [savingDocx, setSavingDocx] = useState(false);
  const [recognizingId, setRecognizingId] = useState<string | null>(null);
  const [saveOptions, setSaveOptions] = useState<SaveDocOptions>(defaultSaveOptions);
  const [saveParamsOpen, setSaveParamsOpen] = useState(false);
  const [incompleteOpen, setIncompleteOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [expandedMd, setExpandedMd] = useState<Record<string, boolean>>({});
  const [recognizeSummaryError, setRecognizeSummaryError] = useState<string | null>(null);
  const [usageTotals, setUsageTotals] = useState({ prompt: 0, completion: 0 });
  const [showCostWidget, setShowCostWidget] = useState(false);

  const busyRecognize = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API}/config`);
        if (!res.ok) return;
        const data = (await res.json()) as { show_cost_widget?: boolean };
        if (!cancelled && typeof data.show_cost_widget === "boolean") {
          setShowCostWidget(data.show_cost_widget);
        }
      } catch {
        /* оставляем скрытой при ошибке */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const revokePreview = useCallback((it: DocItem) => {
    if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
  }, []);

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
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
          selected: true,
        });
      } else if (kind === "text") {
        const text = await file.text();
        next.push({
          id,
          kind,
          file,
          processed: true,
          textContent: text,
          selected: true,
        });
      } else {
        next.push({
          id,
          kind,
          file,
          processed: false,
          selected: true,
        });
      }
    }
    setItems((prev) => [...prev, ...next]);
  }, []);

  const extractDocxTexts = useCallback(async (list: DocItem[]): Promise<DocItem[]> => {
    let out = [...list];
    const need = out.filter((i) => i.kind === "docx" && i.textContent === undefined);
    for (const it of need) {
      const fd = new FormData();
      fd.append("file", it.file);
      const r = await fetch(`${API}/extract-docx-text`, { method: "POST", body: fd });
      const raw = await r.text();
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : {};
      } catch {
        if (!r.ok) throw new Error(`[HTTP ${r.status}] ${raw.slice(0, 800)}`);
        throw new Error("Некорректный JSON ответа");
      }
      if (!r.ok) {
        const msg = formatFastApiDetail((parsed as { detail?: unknown }).detail);
        throw new Error(msg ? `[HTTP ${r.status}] ${msg}` : `[HTTP ${r.status}] ${raw.slice(0, 800)}`);
      }
      const data = parsed as { text: string };
      out = out.map((x) => (x.id === it.id ? { ...x, textContent: data.text, processed: true } : x));
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
    setExpandedMd((m) => {
      const c = { ...m };
      delete c[id];
      return c;
    });
  };

  const toggleSelected = (id: string) => {
    setItems((prev) =>
      prev.map((x) => (x.id === id && x.kind === "image" ? { ...x, selected: !x.selected } : x))
    );
  };

  const toggleExpandMd = (id: string) => {
    setExpandedMd((m) => ({ ...m, [id]: !m[id] }));
  };

  /** Последовательное распознавание одного изображения за раз. */
  useEffect(() => {
    const next = items.find((i) => i.kind === "image" && !i.processed && !i.error);
    if (!next || busyRecognize.current) return;

    busyRecognize.current = true;
    setRecognizingId(next.id);
    setRecognizeSummaryError(null);

    const fd = new FormData();
    fd.append("file", next.file);

    void (async () => {
      try {
        const r = await fetch(`${API}/process-image`, { method: "POST", body: fd });
        const raw = await r.text();
        let data: unknown;
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch {
          if (!r.ok) {
            throw new Error(`[HTTP ${r.status}] Ответ не JSON: ${raw.slice(0, 500)}`);
          }
          throw new Error("Пустой или некорректный JSON от сервера");
        }
        if (!r.ok) {
          const msg = formatFastApiDetail((data as { detail?: unknown }).detail);
          throw new Error(
            msg ? `[HTTP ${r.status}] ${msg}` : `[HTTP ${r.status}] ${raw.slice(0, 4000) || r.statusText}`
          );
        }
        const payload = data as {
          markdown: string;
          figures: FigureInfo[];
          usage?: UsageChunk;
        };
        if (payload.usage) {
          const pt = Number(payload.usage.prompt_tokens) || 0;
          const ct = Number(payload.usage.completion_tokens) || 0;
          if (mountedRef.current) {
            setUsageTotals((u) => ({ prompt: u.prompt + pt, completion: u.completion + ct }));
          }
        }
        if (mountedRef.current) {
          setItems((prev) =>
            prev.map((x) =>
              x.id === next.id
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
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (mountedRef.current) {
          setRecognizeSummaryError(
            "При распознавании были ошибки. Подробности у соответствующих файлов ниже. Последняя: " + msg
          );
          setItems((prev) => prev.map((x) => (x.id === next.id ? { ...x, error: msg, processed: false } : x)));
        }
      } finally {
        busyRecognize.current = false;
        if (mountedRef.current) setRecognizingId(null);
      }
    })();
  }, [items]);

  const buildSections = (
    list: DocItem[],
    opts: SaveDocOptions
  ): { markdown: string; blobs: { name: string; blob: Blob }[] } => {
    const blobs: { name: string; blob: Blob }[] = [];
    const parts: string[] = [];
    let shotCounter = 0;

    const includeImage = (it: DocItem) => {
      if (it.kind !== "image" || !it.processed) return false;
      if (opts.saveAll) return true;
      return it.selected;
    };

    for (const it of list) {
      if (it.kind === "image") {
        if (!includeImage(it)) continue;
        shotCounter += 1;
        const n = shotCounter;
        const ext = extOf(it.file.name) || "png";
        const origName = `original_${it.id}.${ext}`;

        // Порядок в документе: (1) исходный снимок (2) распознанный текст (3) фрагменты — только после текста.
        if (opts.insertScreenshots) {
          parts.push(sepCenter(`========== снимок экрана ${n} ==========`));
          parts.push(`![](media/${origName})\n\n`);
          blobs.push({ name: origName, blob: it.file });
        }

        let rawMd = stripMarkdownImages(it.markdown || "");
        if (opts.latexFormulas && opts.convertMarkdown) {
          rawMd = prepareLatexSafeMarkdown(rawMd);
        }
        parts.push(sepCenter(`========== текст снимка экрана ${n} ==========`));
        parts.push(opts.convertMarkdown ? `${rawMd}\n\n` : wrapMarkdownAsLiteral(rawMd));

        if (opts.insertFigures && it.figures && it.figures.length > 0) {
          parts.push(sepCenter(`========== фрагменты изображений ==========`));
          for (const f of it.figures) {
            parts.push(`![](media/${it.id}_fig_${f.index}.png)\n\n`);
            blobs.push({
              name: `${it.id}_fig_${f.index}.png`,
              blob: base64ToBlob(f.base64),
            });
          }
        }
        continue;
      }

      if (it.kind === "text" && it.textContent !== undefined) {
        parts.push(sepCenter(`========== файл: ${it.file.name} ==========`));
        parts.push(it.textContent);
      } else if (it.kind === "docx" && it.textContent !== undefined) {
        parts.push(sepCenter(`========== файл: ${it.file.name} ==========`));
        parts.push(it.textContent);
      }
    }

    return { markdown: parts.join("").trim() + "\n", blobs };
  };

  const runDocxExport = async () => {
    const fresh = await extractDocxTexts(items);
    const { markdown, blobs } = buildSections(fresh, saveOptions);
    if (!markdown.trim()) {
      alert("Нет содержимого для сохранения.");
      return;
    }
    const fd = new FormData();
    fd.append("markdown", markdown);
    fd.append("convert_markdown", String(saveOptions.convertMarkdown));
    fd.append("preserve_latex", String(saveOptions.latexFormulas));
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
  };

  const onSaveDocx = async () => {
    setSavingDocx(true);
    try {
      await runDocxExport();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingDocx(false);
    }
  };

  const recognitionIncomplete = useMemo(
    () => items.some((i) => i.kind === "image" && !i.processed && !i.error),
    [items]
  );

  const docxBlocked = recognitionIncomplete || items.length === 0 || savingDocx;

  const saveOneMarkdown = (it: DocItem) => {
    const md = it.markdown || "";
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = singleMdDownloadName(it.file.name);
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copyMarkdown = async (md: string) => {
    try {
      await navigator.clipboard.writeText(md);
    } catch {
      alert("Не удалось скопировать в буфер обмена.");
    }
  };

  const clearAll = () => {
    items.forEach(revokePreview);
    setItems([]);
    setRecognizeSummaryError(null);
    setExpandedMd({});
  };

  const costUsd =
    (usageTotals.prompt * PRICE_IN_PER_M + usageTotals.completion * PRICE_OUT_PER_M) / 1_000_000;

  const hasSessionData = items.length > 0 || recognizingId !== null;

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!hasSessionData) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasSessionData]);

  const requestClearAll = () => {
    if (items.length === 0) return;
    setClearConfirmOpen(true);
  };

  /** Вставка скриншотов Ctrl+V с любой точки страницы (кроме полей ввода). */
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const files = filesFromClipboard(e);
      if (files.length === 0) return;
      e.preventDefault();
      void addFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [addFiles]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>Перевод снимков экрана в Word</h1>
        <p className="sub">
          Сделайте один или несколько снимков экрана, вставьте их напрямую из буфера обмена или загрузите как изображения. Распознавание
          запускается автоматически. Экспорт в <code>.docx</code> — кнопка «Сохранить DOCX». По кнопке «Параметры
          сохранения» можно настроить содержимое файла.
        </p>
      </header>

      <div
        className={`dropzone ${drag ? "drag" : ""}`}
        tabIndex={0}
        role="region"
        aria-label="Зона загрузки файлов и вставки из буфера обмена"
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
        <p>
          Перетащите файлы сюда, выберите на диске или вставьте снимок экрана из буфера (
          <kbd>Ctrl</kbd>+<kbd>V</kbd> / <kbd>⌘</kbd>+<kbd>V</kbd>)
        </p>
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

      <div className="actions-wrap">
        <div className="actions">
          <button
            type="button"
            className={`btn btn-secondary ${docxBlocked ? "btn-looks-disabled" : ""}`}
            aria-disabled={docxBlocked}
            onClick={() => {
              if (items.length === 0 || savingDocx) return;
              if (recognitionIncomplete) {
                setIncompleteOpen(true);
                return;
              }
              void onSaveDocx();
            }}
          >
            Сохранить DOCX
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setSaveParamsOpen(true)}>
            Параметры сохранения
          </button>
          <button type="button" className="btn btn-danger" onClick={requestClearAll}>
            Очистить всё
          </button>
        </div>
      </div>

      {recognizeSummaryError && (
        <div className="error-banner" role="alert">
          <div className="error-banner-text">{recognizeSummaryError}</div>
          <button type="button" className="btn error-banner-close" onClick={() => setRecognizeSummaryError(null)}>
            Закрыть
          </button>
        </div>
      )}

      <div className="file-list">
        {items.map((it) => (
          <div
            key={it.id}
            className={`file-row-outer ${it.kind === "image" && it.processed && !it.error && expandedMd[it.id] ? "is-open" : ""}`}
          >
            <div className={`file-row ${it.error ? "file-row-error" : ""}`}>
              {it.kind === "image" ? (
                <label className="row-check-wrap" title="Участвует в сохранении при режиме «выделенное»">
                  <input type="checkbox" checked={it.selected} onChange={() => toggleSelected(it.id)} />
                </label>
              ) : (
                <span className="row-check-spacer" aria-hidden />
              )}
              {it.kind === "image" && it.previewUrl ? (
                <img className="preview" src={it.previewUrl} alt="" />
              ) : (
                <span className="file-icon-emoji" aria-hidden>
                  {it.kind === "docx" ? "📄" : "📃"}
                </span>
              )}
              <div className="file-meta">
                <div className="name">{it.file.name}</div>
                <div className="status">
                  {it.kind === "image" &&
                    (it.error
                      ? "Ошибка распознавания"
                      : it.processed
                        ? "Распознано"
                        : recognizingId === it.id
                          ? "Распознавание…"
                          : "В очереди…")}
                  {it.kind === "text" && "Текст"}
                  {it.kind === "docx" && (it.textContent !== undefined ? "Текст извлечён" : "Ожидает извлечения")}
                </div>
                {it.error && (
                  <pre className="error-detail" title={it.error}>
                    {it.error}
                  </pre>
                )}
              </div>
              {it.kind === "image" && recognizingId === it.id && (
                <span className="spinner" aria-label="Идёт распознавание" />
              )}
              {it.kind === "image" && it.processed && !it.error && (
                <button
                  type="button"
                  className={`chevron-toggle ${expandedMd[it.id] ? "open" : ""}`}
                  aria-expanded={!!expandedMd[it.id]}
                  aria-label={expandedMd[it.id] ? "Свернуть текст" : "Показать распознанный текст"}
                  onClick={() => toggleExpandMd(it.id)}
                />
              )}
              <button type="button" className="btn btn-row-delete" onClick={() => removeItem(it.id)}>
                Удалить
              </button>
            </div>

            {it.kind === "image" && it.processed && !it.error && expandedMd[it.id] && (
              <div className="md-pocket">
                <div className="md-pocket-toolbar">
                  <button type="button" className="btn btn-small" onClick={() => saveOneMarkdown(it)}>
                    Сохранить
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-icon"
                    title="Копировать в буфер обмена"
                    aria-label="Копировать в буфер обмена"
                    onClick={() => void copyMarkdown(it.markdown || "")}
                  >
                    ⧉
                  </button>
                </div>
                <pre className="md-pocket-body">{it.markdown || ""}</pre>
              </div>
            )}
          </div>
        ))}
      </div>

      {showCostWidget && (
        <div className="cost-widget" title="Сумма по ответам API за эту сессию страницы">
          <span className="cost-label">Затраты (сессия)</span>
          <span className="cost-line">
            in {usageTotals.prompt.toLocaleString("ru-RU")} tok · out {usageTotals.completion.toLocaleString("ru-RU")} tok
          </span>
          <span className="cost-line cost-usd">≈ {costUsd < 0.0001 ? "< 0.0001" : costUsd.toFixed(4)} USD</span>
        </div>
      )}

      {saveParamsOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => e.target === e.currentTarget && setSaveParamsOpen(false)}
        >
          <div className="modal modal-wide">
            <h3>Параметры сохранения</h3>
            <div className="save-params-form">
              <div className="field-row field-row-radio">
                <label className="radio-inline">
                  <input
                    type="radio"
                    name="save-scope"
                    checked={saveOptions.saveAll}
                    onChange={() => setSaveOptions((o) => ({ ...o, saveAll: true }))}
                  />
                  Сохранить всё
                </label>
                <label className="radio-inline">
                  <input
                    type="radio"
                    name="save-scope"
                    checked={!saveOptions.saveAll}
                    onChange={() => setSaveOptions((o) => ({ ...o, saveAll: false }))}
                  />
                  Сохранить выделенное
                </label>
              </div>
              <label className="field-row">
                <input
                  type="checkbox"
                  checked={saveOptions.insertScreenshots}
                  onChange={(e) => setSaveOptions((o) => ({ ...o, insertScreenshots: e.target.checked }))}
                />
                Вставлять исходные снимки экрана
              </label>
              <label className="field-row">
                <input
                  type="checkbox"
                  checked={saveOptions.insertFigures}
                  onChange={(e) => setSaveOptions((o) => ({ ...o, insertFigures: e.target.checked }))}
                />
                Найти изображения и вставить их в документ (возможно, затем потребуется обрезать изображение вручную)
              </label>
              <label className="field-row">
                <input
                  type="checkbox"
                  checked={saveOptions.convertMarkdown}
                  onChange={(e) => setSaveOptions((o) => ({ ...o, convertMarkdown: e.target.checked }))}
                />
                Преобразовать Markdown в форматирование Word
              </label>
              <label className="field-row">
                <input
                  type="checkbox"
                  checked={saveOptions.latexFormulas}
                  onChange={(e) => setSaveOptions((o) => ({ ...o, latexFormulas: e.target.checked }))}
                />
                Формулы LaTeX (не преобразовывать в формулы Word, оставить как текст)
              </label>
            </div>
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={() => setSaveParamsOpen(false)}>
                Готово
              </button>
            </div>
          </div>
        </div>
      )}

      {incompleteOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => e.target === e.currentTarget && setIncompleteOpen(false)}
        >
          <div className="modal">
            <h3>Распознавание не завершено</h3>
            <p className="modal-note">Дождитесь окончания распознавания всех изображений, затем сохраните документ.</p>
            <div className="actions">
              <button type="button" className="btn btn-primary" onClick={() => setIncompleteOpen(false)}>
                ОК
              </button>
            </div>
          </div>
        </div>
      )}

      {clearConfirmOpen && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={(e) => e.target === e.currentTarget && setClearConfirmOpen(false)}
        >
          <div className="modal" role="dialog" aria-labelledby="clear-confirm-title" aria-modal="true">
            <h3 id="clear-confirm-title">Очистить всё</h3>
            <p className="modal-note">Вы уверены, что хотите удалить все распознанные страницы?</p>
            <div className="actions modal-actions-split">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setClearConfirmOpen(false)}
              >
                Нет
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  clearAll();
                  setClearConfirmOpen(false);
                }}
              >
                Да
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
