export function formatMoney(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 本地时间 HH:mm:ss */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 本地日期时间 MM-DD HH:mm:ss */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${formatTime(iso)}`;
}
