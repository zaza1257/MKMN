// Re-export of the pure shared brand module: existing renderer imports
// (./brand) keep working, and the constants themselves carry no renderer
// or Node coupling (src/shared/brand.ts).
export { BRAND } from "../shared/brand";
