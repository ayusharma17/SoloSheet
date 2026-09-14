/** Pack indivisible blocks in reading order; never silently clip an oversized block. */
export function paginateBlocks(heights: number[], columnHeight: number, columns: number) {
  if (heights.length === 0) return { pages: [], oversized: false };

  const pages: number[][][] = [[[]]];
  let used = 0;
  let oversized = false;
  for (let index = 0; index < heights.length; index++) {
    const height = heights[index];
    if (!Number.isFinite(height) || height > columnHeight + 0.5) oversized = true;
    let page = pages[pages.length - 1];
    let column = page[page.length - 1];
    if (column.length && used + height > columnHeight + 0.5) {
      if (page.length === columns) {
        page = [[]];
        pages.push(page);
      } else page.push([]);
      column = page[page.length - 1];
      used = 0;
    }
    column.push(index);
    used += height;
  }
  return { pages, oversized };
}
