const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
void chunks;
process.stdout.write(JSON.stringify({ sourceTokenScore: 42, totalTokenScore: 50, sourceLines: 40, testTokenScore: 8 }));
