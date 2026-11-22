export function reportPdfFixture() {
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>',
    ];
    let file = '%PDF-1.7\n';
    const entries = ['0000000000 65535 f '];
    for (const [index, object] of objects.entries()) {
        entries.push(`${String(file.length).padStart(10, '0')} 00000 n `);
        file += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const startxref = file.length;
    file += `xref\n0 ${entries.length}\n${entries.join('\n')}\n`;
    return `${file}trailer\n<< /Size ${entries.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
}
