export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function add(a: number, b: number): number {
  return a + b;
}

// Intentional error: wrong type
export const broken: number = "this is not a number" as unknown as number;

const result = greet("world");
console.log(result);
