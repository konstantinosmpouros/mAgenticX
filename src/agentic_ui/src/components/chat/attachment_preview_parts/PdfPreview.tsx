import * as React from "react";

import { cn } from "@/shared/lib/utils";
import { PreviewLoading } from "./PreviewChrome";

type PdfPreviewProps = {
  name: string;
  url: string;
};

export function PdfPreview({ name, url }: PdfPreviewProps) {
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    setLoaded(false);
  }, [url]);

  return (
    <div className="relative h-full overflow-hidden rounded-[1.4rem] border border-white/10 bg-[#2d2d2d]">
      {!loaded ? <PreviewLoading label="Opening PDF preview..." /> : null}
      <iframe
        key={url}
        title={name}
        src={url}
        className={cn("h-full w-full border-0 bg-[#2d2d2d]", !loaded && "opacity-0")}
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
