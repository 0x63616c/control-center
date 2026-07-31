import { Console } from "@/features/console/Console";
import { useConsole } from "@/features/console/useConsole";

export function App() {
  return <Console state={useConsole()} />;
}
