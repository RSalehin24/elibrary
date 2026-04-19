import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch } from "../api/client";
import {
  CATALOG_TABLE_BATCH_SIZE,
  normalizeBookPayload,
} from "../utils/catalogBooks";
import { toQueryString } from "../utils/query";

export function useInfiniteCatalogBooks({
  endpoint = "/catalog/books/",
  filters,
  enabled = true,
}) {
  const requestFilters = useMemo(() => {
    const { page, limit, ...rest } = filters || {};
    return rest;
  }, [filters]);
  const [tableState, setTableState] = useState({
    books: [],
    totalCount: 0,
    currentPage: 0,
    hasMore: false,
    loadedOnce: false,
    initialLoading: false,
    loadingMore: false,
    refreshing: false,
    error: "",
  });
  const tableStateRef = useRef(tableState);
  const tableShellRef = useRef(null);
  const observerRef = useRef(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    tableStateRef.current = tableState;
  }, [tableState]);

  const loadPage = useCallback(
    async ({
      page = 1,
      limit = CATALOG_TABLE_BATCH_SIZE,
      append = false,
      preserveRows = false,
    } = {}) => {
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;

      setTableState((current) => ({
        ...current,
        initialLoading: !append && !preserveRows && !current.loadedOnce,
        loadingMore: append,
        refreshing: !append && (preserveRows || current.loadedOnce),
        error: "",
        books: append || preserveRows || current.loadedOnce ? current.books : [],
        totalCount:
          append || preserveRows || current.loadedOnce ? current.totalCount : 0,
      }));

      try {
        const payload = await apiFetch(
          `${endpoint}${toQueryString({
            ...requestFilters,
            page: String(page),
            limit: String(limit),
          })}`,
        );
        if (requestSeqRef.current !== requestSeq) {
          return null;
        }

        const normalized = normalizeBookPayload(payload);
        const nextPage = Number(normalized.pagination.page) || page;

        setTableState((current) => ({
          books: append
            ? [...current.books, ...normalized.entries]
            : normalized.entries,
          totalCount: Number(normalized.pagination.total_count) || 0,
          currentPage: nextPage,
          hasMore: Boolean(normalized.pagination.has_next),
          loadedOnce: true,
          initialLoading: false,
          loadingMore: false,
          refreshing: false,
          error: "",
        }));

        return normalized;
      } catch (nextError) {
        if (requestSeqRef.current !== requestSeq) {
          return null;
        }

        setTableState((current) => ({
          ...current,
          books: append || preserveRows || current.loadedOnce ? current.books : [],
          totalCount:
            append || preserveRows || current.loadedOnce ? current.totalCount : 0,
          loadedOnce: true,
          initialLoading: false,
          loadingMore: false,
          refreshing: false,
          error: nextError.message || "Unable to load books.",
        }));

        return null;
      }
    },
    [endpoint, requestFilters],
  );

  const loadMore = useCallback(async () => {
    const current = tableStateRef.current;

    if (
      !enabled ||
      current.initialLoading ||
      current.refreshing ||
      current.loadingMore ||
      !current.hasMore
    ) {
      return null;
    }

    return loadPage({
      page: current.currentPage + 1,
      append: true,
    });
  }, [enabled, loadPage]);

  const observeLoadTrigger = useCallback(
    (node) => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }

      const current = tableStateRef.current;
      if (
        !node ||
        !enabled ||
        current.initialLoading ||
        current.refreshing ||
        current.loadingMore ||
        !current.hasMore
      ) {
        return;
      }

      observerRef.current = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            loadMore();
          }
        },
        {
          root: tableShellRef.current,
          rootMargin: "0px 0px 240px 0px",
        },
      );

      observerRef.current.observe(node);
    },
    [enabled, loadMore],
  );

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const hasLoadedRows = tableStateRef.current.books.length > 0;
    loadPage({
      page: 1,
      limit: CATALOG_TABLE_BATCH_SIZE,
      append: false,
      preserveRows: hasLoadedRows,
    });

    return undefined;
  }, [enabled, loadPage]);

  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  return {
    ...tableState,
    loadMore,
    tableShellRef,
    observeLoadTrigger,
  };
}
