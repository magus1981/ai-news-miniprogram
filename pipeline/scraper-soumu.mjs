/**
 * 日本総務省（soumu.go.jp）報道資料爬虫
 * 官方提供RDF（RSS 1.0）feed：https://www.soumu.go.jp/news.rdf
 * RDF条目含 <title> <link> <dc:date>(ISO8601带时区，如 2026-08-10T05:00:00+09:00)
 * rss-parser对RDF兼容性差，故用cheerio xmlMode直接解析。
 * 2026-08-11 实测无反爬；RDF为UTF-8，编码无坑（HTML列表页才是Shift_JIS，故不用）。
 */
import * as cheerio from 'cheerio';

const RDF = 'https://www.soumu.go.jp/news.rdf';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function scrapeSoumu(source) {
  try {
    const resp = await fetch(RDF, {
      headers: { 'User-Agent': UA, 'Accept': 'application/rdf+xml,application/xml,text/xml,*/*' },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) { console.error(`  [FAIL] 総務省爬虫: HTTP ${resp.status}`); return []; }
    // RDF声明为Shift_JIS编码，resp.text()默认UTF-8解码会乱码，须手动解码
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder('shift_jis').decode(buf);
    const $ = cheerio.load(text, { xmlMode: true });

    const articles = [];
    const seen = new Set();
    $('item').each((_, el) => {
      const title = $(el).find('title').text().trim();
      let link = $(el).find('link').text().trim();
      if (!link) {
        // RDF: link可能用 rdf:about 属性
        link = $(el).attr('rdf:about') || '';
      }
      if (!title || title.length < 5 || !link || seen.has(link)) return;
      seen.add(link);
      if (link.startsWith('//')) link = 'https:' + link;
      else if (link.startsWith('/')) link = 'https://www.soumu.go.jp' + link;

      // dc:date 命名空间，xmlMode下标签名为 "dc:date"
      const dateStr = $(el).find('dc\\:date').text().trim() || $(el).find('date').text().trim();
      let publishedAt = null;
      if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) publishedAt = d.toISOString();
      }

      articles.push({
        title,
        source_name: source.name,
        source_url: link,
        category: source.category,
        language: source.language,
        source_type: source.source_type,
        content_snippet: title,
        published_at: publishedAt,
      });
    });
    return articles;
  } catch (error) {
    console.error(`  [FAIL] 総務省爬虫: ${error.message}`);
    return [];
  }
}
