import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../api/client";
import { decodeValue, manifestFromLaunchUrl } from "./params";

export function useReaderLaunch({
  searchParams,
  setSearchParams,
  slugParam,
  launchParam,
  manifestParam,
  toast,
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const decodedLaunchParam = useMemo(
    () => decodeValue(launchParam),
    [launchParam],
  );
  const decodedManifestParam = useMemo(
    () => decodeValue(manifestParam),
    [manifestParam],
  );

  useEffect(() => {
    let active = true;

    async function resolveManifestUrl() {
      setLoading(true);
      setError("");

      try {
        if (decodedManifestParam) {
          return;
        }

        const manifestFromLaunch = manifestFromLaunchUrl(decodedLaunchParam);
        if (manifestFromLaunch) {
          if (active) {
            setSearchParams(
              (prevParams) => {
                const nextParams = new URLSearchParams(prevParams);
                nextParams.set("manifest", manifestFromLaunch);
                if (!nextParams.get("appNav")) {
                  nextParams.set("appNav", "hidden");
                }
                return nextParams;
              },
              { replace: true },
            );
          }
          return;
        }

        if (!slugParam) {
          throw new Error("Missing reader details. Open a book and try again.");
        }

        const payload = await apiFetch(`/access/books/${slugParam}/reader-launch/`, {
          method: "POST",
          body: {},
        });
        const manifestUrl =
          payload.manifest_url || manifestFromLaunchUrl(payload.launch_url);

        if (!manifestUrl) {
          throw new Error("Reader manifest is not available for this book yet.");
        }

        if (active) {
          setSearchParams(
            (prevParams) => {
              const nextParams = new URLSearchParams(prevParams);
              nextParams.set("manifest", manifestUrl);
              nextParams.delete("launch");
              if (!nextParams.get("appNav")) {
                nextParams.set("appNav", "hidden");
              }
              return nextParams;
            },
            { replace: true },
          );
        }
      } catch (nextError) {
        if (active) {
          const message = nextError?.message || "Could not open reader.";
          setError(message);
          toast.error(message);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    resolveManifestUrl();
    return () => {
      active = false;
    };
  }, [
    decodedLaunchParam,
    decodedManifestParam,
    setSearchParams,
    slugParam,
    toast,
  ]);

  return {
    loading,
    setLoading,
    error,
    setError,
    decodedManifestParam,
  };
}
