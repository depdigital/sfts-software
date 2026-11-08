// Presentation labels and input aliases; stored category names remain stable.
(function(root) {
  const key = value => String(value || '').trim().toUpperCase().replace(/KGS\b/g, 'KG').replace(/[^A-Z0-9.]/g, '');
  function label(category) {
    if (!category) return '';
    const limit = String(category.limit || '').trim().toUpperCase();
    const upper = limit.match(/(?:EXCEEDING |TO )(\d+(?:\.\d+)?) KG$/);
    if (upper) return 'Under ' + Number(upper[1]) + ' kg';
    const lower = limit.match(/^OVER (\d+(?:\.\d+)?) KG$/);
    if (lower) return 'Over ' + Number((Number(lower[1]) - (lower[1].endsWith('.1') ? 0.1 : 0)).toFixed(6)) + ' kg';
    return category.name;
  }
  function resolve(division, gender, value) {
    const choices = (division?.weightCategories?.[String(gender).toUpperCase()] || []).filter(c => key(c.name) === key(value) || key(label(c)) === key(value));
    return choices.length === 1 ? choices[0] : null;
  }
  function display(divisions, entry) {
    if (!entry) return '';
    if (entry.categoryGroup) return entry.categoryGroup;
    const division = divisions.find(d => key(d.id) === key(entry.division) || key(d.label) === key(entry.divisionLabel || entry.division));
    const category = resolve(division, entry.gender, entry.weightCategory);
    return category ? label(category) : entry.weightCategory || '';
  }
  root.SftsWeightLabels = Object.freeze({ label, resolve, display });
})(globalThis);
