import * as React from "react";

type DocxPreviewProps = {
  viewerUrl: string;
  name: string;
};

export function DocxPreview({ viewerUrl, name }: DocxPreviewProps) {
  return (
    <div className="h-full overflow-hidden rounded-[1.4rem] border border-white/10">
      <iframe
        src={viewerUrl}
        className="h-full w-full border-0"
        title={name}
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      />
    </div>
  );
}
