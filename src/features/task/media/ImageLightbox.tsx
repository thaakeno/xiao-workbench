import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { XiaoIcon } from "../../../components/icons/XiaoIcon";

export function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(100);
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const changeZoom = (next: number) => setZoom(Math.min(250, Math.max(50, next)));
  return createPortal(
    <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`Preview ${alt}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <header>
        <span title={alt}>{alt}</span>
        <button type="button" aria-label="Zoom out" onClick={() => changeZoom(zoom - 25)}>−</button>
        <output>{zoom}%</output>
        <button type="button" aria-label="Zoom in" onClick={() => changeZoom(zoom + 25)}>+</button>
        <button type="button" aria-label="Close image preview" onClick={onClose}><XiaoIcon name="close" size={15} /></button>
      </header>
      <div className="image-lightbox__stage" onWheel={(event) => { event.preventDefault(); changeZoom(zoom + (event.deltaY < 0 ? 10 : -10)); }}>
        <img src={src} alt={alt} style={{ transform: `scale(${zoom / 100})` }} draggable={false} />
      </div>
    </div>,
    document.body,
  );
}
