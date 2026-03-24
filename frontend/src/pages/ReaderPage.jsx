import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import PageLoader from "../components/PageLoader";
import { useToast } from "../hooks/useToast";
import readerResetCssUrl from "../embedded-reader/static/css/base/reset.css?url";
import readerIconfontCssUrl from "../embedded-reader/static/css/base/iconfont.css?url";
import readerHelpersCssUrl from "../embedded-reader/static/css/base/helpers.css?url";
import readerShortcutsCssUrl from "../embedded-reader/static/css/components/shortcuts-dialog.css?url";
import readerLayoutCssUrl from "../embedded-reader/static/css/components/reader-layout.css?url";
import readerThemeTokensCssUrl from "../embedded-reader/static/css/themes/theme-tokens.css?url";
import readerThemeOverridesCssUrl from "../embedded-reader/static/css/themes/theme-overrides.css?url";

function decodeValue(value) {
  if (!value) {
    return "";
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export default function ReaderPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const slugParam = searchParams.get("slug") || "";
  const launchParam = searchParams.get("launch") || "";
  const manifestParam = searchParams.get("manifest") || "";
  const appNav = searchParams.get("appNav") || "hidden";
  const navHidden = appNav === "hidden";

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isReaderBooted, setIsReaderBooted] = useState(false);
  const readerRef = useRef(null);

  const decodedLaunchParam = useMemo(
    () => decodeValue(launchParam),
    [launchParam],
  );

  const decodedManifestParam = useMemo(
    () => decodeValue(manifestParam),
    [manifestParam],
  );

  const targetBookPath = slugParam
    ? `/books/${encodeURIComponent(slugParam)}`
    : "/create";

  function manifestFromLaunchUrl(launchUrlValue) {
    if (!launchUrlValue) {
      return "";
    }

    try {
      const parsed = new URL(launchUrlValue, window.location.origin);
      const manifest = parsed.searchParams.get("manifest") || "";
      return manifest ? decodeValue(manifest) : "";
    } catch {
      return "";
    }
  }

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

        const payload = await apiFetch(
          `/access/books/${slugParam}/reader-launch/`,
          {
            method: "POST",
            body: {},
          },
        );

        const manifestUrl =
          payload.manifest_url || manifestFromLaunchUrl(payload.launch_url);
        if (!manifestUrl) {
          throw new Error(
            "Reader manifest is not available for this book yet.",
          );
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

  useEffect(() => {
    if (!decodedManifestParam) {
      return undefined;
    }

    let active = true;
    let instance = null;

    async function mountReader() {
      try {
        const links = [
          readerResetCssUrl,
          readerIconfontCssUrl,
          readerHelpersCssUrl,
          readerShortcutsCssUrl,
          readerLayoutCssUrl,
          readerThemeTokensCssUrl,
          readerThemeOverridesCssUrl,
        ];

        const styleNodes = links.map((href) => {
          const node = document.createElement("link");
          node.rel = "stylesheet";
          node.href = href;
          document.head.appendChild(node);
          return node;
        });

        const [{ ensureEpubRuntime }, { ReaderApplication }] =
          await Promise.all([
            import("../embedded-reader/static/js/vendor/epub-runtime/runtime-entry.js"),
            import("../embedded-reader/static/js/reader/reader-application.js"),
          ]);

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
        readerRef.current = {
          styleNodes,
          instance,
        };
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
      const current = readerRef.current;
      if (current?.instance) {
        current.instance.destroy?.();
      }
      if (current?.styleNodes?.length) {
        current.styleNodes.forEach((node) => node.remove());
      }
      readerRef.current = null;
    };
  }, [decodedManifestParam, toast]);

  function toggleAppNav() {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("appNav", navHidden ? "shown" : "hidden");
    setSearchParams(nextParams, { replace: true });
  }

  if (loading) {
    return (
      <PageLoader
        label="Opening reader"
        detail="Preparing your book preview."
      />
    );
  }

  if (error) {
    return (
      <section className="page-state reader-page-state">
        <h2>Reader unavailable</h2>
        <p>{error}</p>
        <div className="reader-toolbar">
          <button
            type="button"
            className="reader-header-icon"
            onClick={toggleAppNav}
            aria-label={navHidden ? "Show main header" : "Hide main header"}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M3 6.75h18M3 12h18M3 17.25h18" />
            </svg>
          </button>
          <button
            type="button"
            className="reader-header-icon"
            onClick={() => navigate(targetBookPath)}
            aria-label="Back to book"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M14.5 6.5L8.5 12l6 5.5" />
            </svg>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="reader-page-fullscreen epub-container">
      <section
        className="epub-reader-container"
        id="reader-view"
        aria-label="EPUB reader"
      >
        <div id="epub-contents-panel" className="epub-contents" />
        <div className="reader-wrapper">
          <div id="reader-controls" className="wrapper-nav">
            <div className="icon-wrap-first-two">
              <button
                type="button"
                className="icon-wrap icon-control iconmulu"
                aria-label="Toggle table of contents"
                aria-controls="epub-contents-panel"
                aria-expanded="false"
              >
                <span className="iconfont" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <path d="M4.5 6h0M4.5 12h0M4.5 18h0M9 6h10M9 12h10M9 18h10" />
                  </svg>
                </span>
              </button>
              <div className="icon-anchor">
                <button
                  type="button"
                  className="icon-control iconshezhi"
                  aria-label="Open reading settings"
                  aria-haspopup="true"
                  aria-controls="reader-settings-panel"
                  aria-expanded="false"
                >
                  <span className="iconfont" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M12 8.75a3.25 3.25 0 1 0 0 6.5a3.25 3.25 0 0 0 0-6.5Z" />
                      <path d="M12 2.75v2.2M12 19.05v2.2M4.95 4.95l1.55 1.55M17.5 17.5l1.55 1.55M2.75 12h2.2M19.05 12h2.2M4.95 19.05l1.55-1.55M17.5 6.5l1.55-1.55" />
                    </svg>
                  </span>
                </button>
                <div
                  id="reader-settings-panel"
                  className="setting-wrapper"
                  role="group"
                  aria-label="Reading settings"
                  aria-hidden="true"
                >
                  <div className="dropdown-caret">
                    <span className="caret-outer" />
                    <span className="caret-inner" />
                  </div>
                  <div className="setting-size">
                    <button
                      type="button"
                      className="size-btn small"
                      data-tag="small"
                      aria-label="Decrease font size"
                    >
                      A
                    </button>
                    <button
                      type="button"
                      className="size-btn big"
                      data-tag="big"
                      aria-label="Increase font size"
                    >
                      A
                    </button>
                  </div>
                  <div className="setting-background">
                    <button
                      type="button"
                      className="bg-btn"
                      data-type="0"
                      aria-pressed="true"
                    >
                      White
                    </button>
                    <button
                      type="button"
                      className="bg-btn"
                      data-type="1"
                      aria-pressed="false"
                    >
                      Sepia
                    </button>
                    <button
                      type="button"
                      className="bg-btn"
                      data-type="2"
                      aria-pressed="false"
                    >
                      Night
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div className="reader-nav-right">
              <div className="reader-nav-extra">
                <button
                  type="button"
                  className="icon-wrap icon-control reader-nav-extra-btn"
                  onClick={toggleAppNav}
                  aria-label={
                    navHidden ? "Show main header" : "Hide main header"
                  }
                  title={navHidden ? "Show main header" : "Hide main header"}
                >
                  <span className="iconfont" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <rect
                        x="3.25"
                        y="4"
                        width="17.5"
                        height="15.5"
                        rx="2.3"
                        ry="2.3"
                      />
                      <path d="M3.5 9h17" />
                      {navHidden ? (
                        <path d="M12 12.5v4M10.5 15l1.5 1.5 1.5-1.5" />
                      ) : (
                        <path d="M12 16.5v-4M10.5 14l1.5-1.5 1.5 1.5" />
                      )}
                    </svg>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-wrap icon-control reader-nav-extra-btn"
                  onClick={() => navigate(targetBookPath)}
                  aria-label="Back to book"
                  title="Back to book"
                >
                  <span className="iconfont" aria-hidden="true">
                    <svg viewBox="0 0 24 24" focusable="false">
                      <path d="M9.5 6.5 3.5 12l6 5.5" />
                      <path d="M4 12h16" />
                    </svg>
                  </span>
                </button>
              </div>
              <button
                type="button"
                className="icon-wrap icon-control iconcc-close-square"
                aria-label="Close current book"
              >
                <span className="iconfont" aria-hidden="true">
                  <svg viewBox="0 0 24 24" focusable="false">
                    <circle cx="12" cy="12" r="8.25" />
                    <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
                  </svg>
                </span>
              </button>
            </div>
          </div>
          <div className="wrapper-main">
            <button
              type="button"
              className="arrow prev-btn"
              aria-label="Previous section"
            >
              <span className="iconfont iconarrow-left" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M14.5 5.5L8 12l6.5 6.5" />
                </svg>
              </span>
            </button>
            <div id="viewer" className="reader-wrapper-container" />
            <button
              type="button"
              className="arrow next-btn"
              aria-label="Next section"
            >
              <span className="iconfont iconarrowright" aria-hidden="true">
                <svg viewBox="0 0 24 24" focusable="false">
                  <path d="M9.5 5.5L16 12l-6.5 6.5" />
                </svg>
              </span>
            </button>
          </div>
        </div>
      </section>

      {!isReaderBooted ? (
        <div className="reader-boot-overlay">
          <PageLoader
            label="Opening reader"
            detail="Loading EPUB reader assets."
          />
        </div>
      ) : null}
    </section>
  );
}
