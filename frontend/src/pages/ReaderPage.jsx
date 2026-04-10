import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import PageLoader from "../components/PageLoader";
import ReaderUnavailable from "../features/reader/ReaderUnavailable";
import ReaderViewport from "../features/reader/ReaderViewport";
import { useReaderBoot } from "../features/reader/useReaderBoot";
import { useReaderLaunch } from "../features/reader/useReaderLaunch";
import { useToast } from "../hooks/useToast";

export default function ReaderPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const slugParam = searchParams.get("slug") || "";
  const launchParam = searchParams.get("launch") || "";
  const manifestParam = searchParams.get("manifest") || "";
  const appNav = searchParams.get("appNav") || "hidden";
  const navHidden = appNav === "hidden";

  const { loading, setLoading, error, setError, decodedManifestParam } =
    useReaderLaunch({
      searchParams,
      setSearchParams,
      slugParam,
      launchParam,
      manifestParam,
      toast,
    });
  const { isReaderBooted } = useReaderBoot({
    manifestUrl: decodedManifestParam,
    setLoading,
    setError,
    toast,
  });

  const targetBookPath = slugParam
    ? `/books/${encodeURIComponent(slugParam)}`
    : "/create";

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
      <ReaderUnavailable
        error={error}
        navHidden={navHidden}
        navigate={navigate}
        targetBookPath={targetBookPath}
        toggleAppNav={toggleAppNav}
      />
    );
  }

  return (
    <ReaderViewport
      isReaderBooted={isReaderBooted}
      navHidden={navHidden}
      navigate={navigate}
      targetBookPath={targetBookPath}
      toggleAppNav={toggleAppNav}
    />
  );
}
