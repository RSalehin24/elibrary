import { useEffect, useRef, useState } from "react";
import { READER_STYLE_URLS, loadReaderRuntime } from "./assets";

function appendReaderStyles() {
  return READER_STYLE_URLS.map((href) => {
    const node = document.createElement("link");
    node.rel = "stylesheet";
    node.href = href;
    document.head.appendChild(node);
    return node;
  });
}

function destroyReaderInstance(current) {
  current?.instance?.destroy?.();
  current?.styleNodes?.forEach((node) => node.remove());
}

export function useReaderBoot({ manifestUrl, setLoading, setError, toast }) {
  const [isReaderBooted, setIsReaderBooted] = useState(false);
  const readerRef = useRef(null);

  useEffect(() => {
    if (!manifestUrl) {
      return undefined;
    }

    let active = true;
    let instance = null;

    async function mountReader() {
      try {
        const styleNodes = appendReaderStyles();
        const { ensureEpubRuntime, ReaderApplication } =
          await loadReaderRuntime();

        if (!active) {
          styleNodes.forEach((node) => node.remove());
          return;
        }

        await ensureEpubRuntime();
        if (!active) {
          styleNodes.forEach((node) => node.remove());
          return;
        }

        instance = new ReaderApplication();
        instance.init();
        readerRef.current = { styleNodes, instance };
        setIsReaderBooted(true);
      } catch (bootError) {
        const message =
          bootError?.message || "Failed to initialize EPUB reader.";
        setError(message);
        toast.error(message);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    mountReader();
    return () => {
      active = false;
      setIsReaderBooted(false);
      destroyReaderInstance(readerRef.current);
      readerRef.current = null;
    };
  }, [manifestUrl, setError, setLoading, toast]);

  return { isReaderBooted };
}
