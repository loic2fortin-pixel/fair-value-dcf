const fs = require('fs');
for (const t of ['AMZN', 'MU']) {
  let raw = fs.readFileSync(t + '_facts.json', 'utf8');
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  const json = JSON.parse(raw);
  const tags = Object.keys(json.facts['us-gaap'] || {});
  const daTags = tags.filter(x => /^DepreciationDepletionAndAmortization$|^DepreciationAndAmortization$|^DepreciationAmortizationAndAccretionNet$|^Depreciation$|^AmortizationOfIntangibleAssets$/.test(x));
  console.log(t, 'DA-related tags:', JSON.stringify(daTags));
  console.log(t, 'OperatingIncomeLoss present:', !!json.facts['us-gaap']['OperatingIncomeLoss']);
}
