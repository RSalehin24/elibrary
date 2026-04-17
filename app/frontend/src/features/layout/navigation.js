export const bookPropertiesItems = [
  { to: "/library", label: "Books" },
  { to: "/categories", label: "Categories" },
  { to: "/series", label: "Series" },
  { to: "/writers", label: "Writers" },
  { to: "/manual-books", label: "Physical Books' List" },
];

export const processingItems = [
  {
    to: "/catalog",
    label: "Catalog",
    capabilityRequired: true,
  },
  {
    to: "/create",
    label: "Create",
    capabilityRequired: true,
  },
  {
    to: "/on-hold",
    label: "On Hold",
    capabilityRequired: true,
  },
  {
    to: "/incomplete",
    label: "Incomplete",
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
  return (
    pathname === "/catalog" ||
    pathname === "/create" ||
    pathname === "/on-hold" ||
    pathname === "/incomplete" ||
    pathname.startsWith("/processing")
  );
}

export function authenticatedNavigation(user) {
  if (!user) {
    return [];
  }

  return [
    { to: "/home", label: "Home" },
    ...(user.is_superuser ? [{ to: "/access", label: "Users & Access" }] : []),
  ];
}
