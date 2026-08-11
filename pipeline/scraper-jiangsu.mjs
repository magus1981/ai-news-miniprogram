/**
 * 江苏省人民政府（jiangsu.gov.cn）政策文件爬虫
 * 列表由分页数据接口返回XML（无鉴权、无token）：
 *   GET https://www.jiangsu.gov.cn/module/web/jpage/dataproxy.jsp?page=N&appid=1&webid=1&path=/&columnid=84242&unitid=356383&permissiontype=0
 * 返回 <datastore><record><![CDATA[<li>...<a title="标题" href="/art/2026/8/7/art_46143_xxx.html">标题</a><span class="time">2026- 08- 07</span></li>]]></record>
 * columnid=84242 = "政策文件"栏目（省政府/省政府办公厅文件）。
 * 2026-08-11 实测无UA要求；日期HTML源中含空白，需去空白后解析。
 */
import * as cheerio from 'cheerio';

const API = 'https://www.jiangsu.gov.cn/module/web/jpage/dataproxy.jsp';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PAGES = 1; // 1页返回~300条（服务端慢约15s/页，多页超时风险高）

export async function scrapeJiangsu(source) {
  const articles = [];
  const seenUrls = new Set();

  for (let page = 1; page <= PAGES; page++) {
    try {
      const qs = new URLSearchParams({
        page: String(page), appid: '1', webid: '1', path: '/',
        columnid: '84242', unitid: '356383', permissiontype: '0',
      });
      const resp = await fetch(`${API}?${qs}`, {
        headers: {
          'User-Agent': UA,
          'Accept': 'text/xml,application/xml,text/html,*/*',
          'Referer': 'https://www.jiangsu.gov.cn/col/col84242/index.html',
        },
        signal: AbortSignal.timeout(60000), // 服务器响应慢（约15s），须长超时
      });
      if (!resp.ok) { console.error(`  [FAIL] 江苏爬虫: page ${page} HTTP ${resp.status}`); break; }
      const text = await resp.text();
      const $xml = cheerio.load(text, { xmlMode: true });

      // record 的 CDATA 内含 HTML 片段，用 text() 提取 CDATA 内容后二次解析
      $xml('record').each((_, rec) => {
        const html = $xml(rec).text() || '';
        if (!html) return;
        // 去除转义与空白
        const clean = html.replace(/\s+/g, ' ');
        const $frag = cheerio.load(clean);
        $frag('li a').each((_, el) => {
          const a = $frag(el);
          const title = (a.attr('title') || a.text()).trim();
          let href = a.attr('href') || '';
          if (!href || title.length < 5) return;
          if (href.startsWith('//')) href = 'https:' + href;
          else if (href.startsWith('/')) href = 'https://www.jiangsu.gov.cn' + href;
          if (seenUrls.has(href)) return;
          seenUrls.add(href);

          // 日期在同级 span.time
          const rawDate = a.next('span.time').text().trim() || a.parent().find('span.time').text().trim();
          const dateStr = rawDate.replace(/\s+/g, '');
          const m = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
          const publishedAt = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T09:00:00+08:00`).toISOString() : null;

          articles.push({
            title,
            source_name: source.name,
            source_url: href,
            category: source.category,
            language: source.language,
            source_type: source.source_type,
            content_snippet: title,
            published_at: publishedAt,
          });
        });
      });
    } catch (error) {
      console.error(`  [FAIL] 江苏爬虫: page ${page} ${error.message}`);
      break;
    }
  }

  return articles;
}
