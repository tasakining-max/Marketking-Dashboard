const PORT = process.env.PORT || 5050;

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const entries = JSON.parse(input);
if (!Array.isArray(entries)) throw new Error('expected a JSON array of Thai strings (or {text, date} objects) on stdin');

for (const entry of entries) {
  const { text, date } = typeof entry === 'string' ? { text: entry, date: undefined } : entry;
  const res = await fetch(`http://localhost:${PORT}/api/website-changelog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...(date ? { date } : {}) }),
  });
  const json = await res.json();
  console.log('Logged:', json.feature, json.date);
}
