import "./v2.css";

// Минимальная обёртка — реальный shell (sidebar + main) собирается
// внутри page.tsx чтобы клиентский state (active history, theme) был там.
export default function V2Layout({ children }: { children: React.ReactNode }) {
  return children;
}
