import { greet } from "./index.ts";

export function greetMany(names: string[]): string[] {
  return names.map(greet);
}
