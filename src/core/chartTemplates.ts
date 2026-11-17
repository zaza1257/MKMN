import { chartFlaw } from "./chart";

/**
 * Calculators that come up all the time, written once and tested, so a small model is not asked to write their JSON: it fails at it (brackets
 * in place of objects, unquoted ids), twice in a row even when asked to correct itself. The request decides, with no model call.
 */
const COMPOUND = /\bcompound(?:ed)?\s+interest\b/i;
const LOAN = /\b(?:loan|mortgage)\b/i;

const compound = {
  type: "area",
  title: "Compound interest",
  x: { label: "Years", min: 0, max: "t", step: 1 },
  yLabel: "Euros",
  params: [
    { id: "P", label: "Starting amount", min: 0, max: 1000000, value: 10000, step: 500, unit: "€" },
    { id: "r", label: "Annual rate", min: 0, max: 20, value: 5, step: 0.1, unit: "%" },
    { id: "t", label: "Duration", min: 1, max: 50, value: 10, step: 1, unit: "years" }
  ],
  formulas: [
    { label: "Base formula", tex: "A = P\\left(1+\\frac{r}{100}\\right)^{t}" },
    { label: "With your values", tex: "A = [[P]]\\times\\left(1+\\frac{[[r]]}{100}\\right)^{[[t]]} = [[=P*(1+r/100)^t]]" }
  ],
  outputs: [
    { label: "Final amount", y: "P*(1+r/100)^t", unit: "€" },
    { label: "Interest earned", y: "P*(1+r/100)^t-P", unit: "€" }
  ],
  series: [
    { name: "With interest", y: "P*(1+r/100)^x" },
    { name: "Without interest", y: "P" }
  ]
};

const loan = {
  type: "line",
  title: "Fixed-payment loan",
  x: { label: "Years", min: 0, max: "t", step: 1 },
  yLabel: "Euros",
  params: [
    { id: "P", label: "Amount borrowed", min: 1000, max: 1000000, value: 200000, step: 1000, unit: "€" },
    { id: "r", label: "Annual rate", min: 0.1, max: 15, value: 4, step: 0.1, unit: "%" },
    { id: "t", label: "Duration", min: 1, max: 30, value: 20, step: 1, unit: "years" }
  ],
  formulas: [
    { label: "Base formula", tex: "M = P\\times\\frac{i}{1-(1+i)^{-12t}},\\quad i=\\frac{r}{1200}" },
    { label: "With your values", tex: "M = [[P]]\\times\\frac{[[=r/1200]]}{1-(1+[[=r/1200]])^{-12\\times[[t]]}} = [[=P*(r/1200)/(1-(1+r/1200)^(-12*t))]]" }
  ],
  outputs: [
    { label: "Monthly payment", y: "P*(r/1200)/(1-(1+r/1200)^(-12*t))", unit: "€" },
    { label: "Total cost", y: "12*t*P*(r/1200)/(1-(1+r/1200)^(-12*t))", unit: "€" },
    { label: "Interest paid", y: "12*t*P*(r/1200)/(1-(1+r/1200)^(-12*t))-P", unit: "€" }
  ],
  series: [
    { name: "Remaining balance", y: "P*(1+r/1200)^(12*x)-P*(r/1200)/(1-(1+r/1200)^(-12*t))*((1+r/1200)^(12*x)-1)/(r/1200)" },
    { name: "Total repaid", y: "12*x*P*(r/1200)/(1-(1+r/1200)^(-12*t))" }
  ]
};

/** The ready-made chart block text for a request that is a known calculator, or null. */
export function templateChart(request: string): { block: string; intro: string } | null {
  const pick = COMPOUND.test(request) ? { spec: compound, intro: "Here is the compound interest calculator: enter the rate, the starting amount and the duration." }
    : LOAN.test(request) && /\b(monthly payment|rate|duration|amount)/i.test(request) ? { spec: loan, intro: "Here is the loan simulator: enter the amount, the rate and the duration." }
    : null;
  if (!pick) return null;
  const raw = JSON.stringify(pick.spec);
  if (chartFlaw(raw) !== null) return null;
  return { block: "```chart\n" + raw + "\n```", intro: pick.intro };
}
