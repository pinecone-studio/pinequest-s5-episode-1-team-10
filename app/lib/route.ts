// Route numbers as riders see them on the bus: Hamuga's copy tags and stray spaces removed
// (" НҮ:2_copy" -> "НҮ:2"). Display only: /verify and /ride still get the full busRouteNo.
export function routeLabel(route: string): string {
  return route.replace(/_copy|-коп/gi, "").trim();
}
