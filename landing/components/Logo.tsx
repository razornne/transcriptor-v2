import { Mark } from "./Mark";

export function Logo() {
  return (
    <a className="logo" href="#top" aria-label="Skriptly home">
      <Mark size={24} />
      <span>Skriptly</span>
    </a>
  );
}
