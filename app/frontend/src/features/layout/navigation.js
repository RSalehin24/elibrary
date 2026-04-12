export const bookPropertiesItems = [
  { to: "/library", label: "Books" },
  { to: "/categories", label: "Categories" },
  { to: "/series", label: "Series" },
  { to: "/writers", label: "Writers" },
  { to: "/manual-books", label: "Physical Books' List" },
];

export const processingItems = [
  {
    to: "/processing-catalog-books",
    label: "Catalog",
    capabilityRequired: true,
  },
  {
    to: "/processing-automation",
    label: "Automation",
    capabilityRequired: true,
  },
  {
    to: "/processing-my-requests",
    label: "My Requests",
    capabilityRequired: false,
  },
  {
    to: "/processing-failed-requests",
    label: "Failed Requests",
    capabilityRequired: true,
  },
  {
    to: "/processing-duplicate-requests",
    label: "Deplicate Requests",
    capabilityRequired: true,
  },
  {
    to: "/processing-incomplete-check",
    label: "Incomplete Requests",
    capabilityRequired: true,
  },
];

export function isBookPropertiesRoute(pathname) {
  return (
    pathname === "/library" ||
    pathname === "/categories" ||
    pathname === "/series" ||
    pathname === "/writers" ||
    pathname === "/translators" ||
    pathname === "/compilers" ||
    pathname === "/editors" ||
    pathname === "/manual-books" ||
    pathname.startsWith("/books/")
  );
}

export function isProcessingRoute(pathname) {
  return pathname.startsWith("/processing");
}

export function authenticatedNavigation(user) {
  if (!user) {
    return [];
  }

  return [
    { to: "/home", label: "Home" },
    { to: "/create", label: "Create Books" },
    ...(user.is_superuser ? [{ to: "/access", label: "Users & Access" }] : []),
  ];
}
