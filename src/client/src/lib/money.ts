/** An answer's cost with enough digits to mean something: 0.0021 rather than 0.00. */
export const formatCost = (n: number): string => n >= 0.01 ? n.toFixed(2) : n.toPrecision(2)
