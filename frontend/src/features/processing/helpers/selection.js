export function toggleSelectedId(currentIds, id) {
  return currentIds.includes(id)
    ? currentIds.filter((currentId) => currentId !== id)
    : [...currentIds, id];
}

export function toggleVisibleSelection(currentIds, visibleIds, allSelected) {
  const nextIds = new Set(currentIds);
  if (allSelected) {
    visibleIds.forEach((id) => nextIds.delete(id));
  } else {
    visibleIds.forEach((id) => nextIds.add(id));
  }
  return Array.from(nextIds);
}

export function selectedActionLabel(label, count) {
  return count ? `${label} (${count})` : label;
}
