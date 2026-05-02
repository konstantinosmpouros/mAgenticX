import * as React from "react";
import { renderAsync } from "docx-preview";

type DocxPreviewProps = {
  blob: Blob;
};

export function DocxPreview({ blob }: DocxPreviewProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    container.innerHTML = "";
    setRenderError(null);

    void renderAsync(blob, container, container, {
      className: "docx-preview-document",
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      useBase64URL: false,
    }).catch((error) => {
      if (!cancelled) {
        container.innerHTML = "";
        setRenderError(error instanceof Error ? error.message : "Unknown error");
      }
    });

    return () => {
      cancelled = true;
      container.innerHTML = "";
    };
  }, [blob]);

  return (
    <div className="h-full overflow-auto rounded-[1.4rem] border border-white/10 bg-[#3b3b3b] p-4">
      {renderError ? (
        <div className="rounded-xl border border-red-400/20 bg-red-950/30 p-4 text-sm text-red-100">
          Failed to render DOCX preview: {renderError}
        </div>
      ) : null}
      <div ref={containerRef} className="mx-auto w-fit max-w-full [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-0" />
    </div>
  );
}
