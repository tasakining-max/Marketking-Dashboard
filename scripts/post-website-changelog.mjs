const PORT = process.env.PORT || 5050;

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;

const entries = JSON.parse(input);
if (!Array.isArray(entries)) throw new Error('expected a JSON array of Thai strings on stdin');

for (const text of entries) {
  const res = await fetch(`http://localhost:${PORT}/api/website-changelog`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const json = await res.json();
  console.log('Logged:', json.feature);
}
