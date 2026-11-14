# -*- coding: utf-8 -*-
"""页 2/3 的回归：慢信息纯函数 + 三页出图（含英文 CJK 拦截与页码提示）。"""
import importlib.util
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


s = load('slowinfo_mod', 'tools/slowinfo.py')
r = load('renderer_pages', 'tools/render_screen.py')


FIXTURE = {
    'ok': True,
    'weather': {
        'ok': True, 'city': '深圳', 'cityEn': 'Shenzhen', 'code': 0, 'text': '晴',
        'temp': 26, 'high': 29, 'low': 22, 'humidity': 60,
        'sunrise': '06:12', 'sunset': '18:04',
        'days': [
            {'date': '11-14', 'code': 0, 'text': '晴', 'high': 26, 'low': 18},
            {'date': '11-15', 'code': 2, 'text': '多云', 'high': 25, 'low': 18},
            {'date': '2026-11-16', 'code': 61, 'text': '小雨', 'high': 23, 'low': 17},
            {'date': '11-17', 'code': 3, 'text': '阴', 'high': 22, 'low': 16},
        ],
    },
    'fx': {'ok': True, 'cny': 7.1, 'inr': 83, 'base': 'USD'},
    'stocks': {'ok': True, 'items': [{'sym': 'SPY', 'label': '标普500', 'price': '700',
                                      'currency': 'USD', 'changePct': -1.2,
                                      'spark': {'closes': [1, 2, 3]}}]},
    'clocks': {'ok': True, 'items': [{'city': '伦敦', 'tz': 'Europe/London',
                                      'time': '08:00', 'date': '10/31 Fri'}]},
    'news': {'ok': True, 'items': [{'title': '中文标题'}]},
    'newsEn': {'ok': True, 'items': [{'title': 'English headline'}]},
    'mlb': {'ok': True, 'items': []},
    'quotas': {
        'workbuddy': {'ok': True, 'model': 'hy3',
                      'context': {'used': 100, 'size': 1000, 'percent': 10},
                      'credit': {'used': 1.5, 'count': 3}},
        'claudecode': {'ok': True, 'used7d': 42, 'sessions7d': 4},
    },
}


class SlowInfoTests(unittest.TestCase):
    def test_solar_terms_cover_the_whole_year(self):
        for year in (2026, 2027, 2030):
            terms = s.solar_terms(year)
            self.assertEqual(len(terms), 24, 'year %d has %d terms' % (year, len(terms)))
            self.assertEqual([t[0] for t in terms], sorted(t[0] for t in terms))
            self.assertTrue(all(t[0].year == year for t in terms))
            self.assertTrue(all(t[1] and t[2] and t[2].isascii() for t in terms))
            self.assertEqual(len({t[1] for t in terms}), 24, 'a duplicated solar term')

    def test_term_at_never_returns_none_even_at_year_edges(self):
        for day in (date(2026, 1, 1), date(2026, 6, 15), date(2026, 12, 31)):
            current, upcoming = s.term_at(day)
            self.assertIsNotNone(current, str(day))
            self.assertIsNotNone(upcoming, str(day))
            self.assertLessEqual(current[2], day)
            self.assertGreater(upcoming[2], day)
            self.assertEqual(upcoming[3], (upcoming[2] - day).days)

    def test_moon_phase_stays_in_synodic_range(self):
        for day in (date(2026, 1, 1), date(2026, 6, 15), date(2026, 12, 31)):
            (zh, en), age = s.moon_phase(day)
            self.assertTrue(zh and en.isascii())
            self.assertGreaterEqual(age, 0)
            self.assertLess(age, s.SYNODIC_MONTH)

    def test_weekend_holiday_and_year_progress(self):
        self.assertEqual([s.days_to_weekend(date(2026, 11, i)) for i in range(9, 16)],
                         [5, 4, 3, 2, 1, 0, 0])
        self.assertEqual(s.next_fixed_day(date(2026, 12, 25))[3], 0)
        self.assertEqual(s.next_fixed_day(date(2026, 12, 26))[2], date(2027, 1, 1))
        self.assertEqual(s.year_progress(date(2026, 1, 1)), 0)
        self.assertEqual(s.year_progress(date(2026, 12, 31)), 100)
        self.assertEqual(s.year_progress(date(2024, 12, 31)), 100)  # leap year

    def test_every_english_label_is_ascii(self):
        for pair in s.TERM_NAMES.values():
            self.assertTrue(pair[1].isascii(), pair[1])
        for pair in s.MOON_NAMES:
            self.assertTrue(pair[1].isascii(), pair[1])
        for _, _, _, en in s.FIXED_DAYS:
            self.assertTrue(en.isascii(), en)


class PageRenderTests(unittest.TestCase):
    def tearDown(self):
        r.LANG = 'zh'

    def test_all_three_pages_render_in_both_languages(self):
        with tempfile.TemporaryDirectory() as tmp:
            for lang in ('zh', 'en'):
                for page in (1, 2, 3):
                    out = Path(tmp) / ('%s_%d.png' % (lang, page))
                    r.render(FIXTURE, str(out), lang, page, 3)
                    self.assertTrue(out.exists() and out.stat().st_size > 1000)
                    if lang == 'en':
                        self.assertEqual(r._cjk_leak(), [], 'page %d leaked Chinese' % page)
                    drawn = ' | '.join(r._DRAWN)
                    self.assertIn('%d/3' % page, drawn, 'page indicator missing on page %d' % page)
                    # 页 2 慢信息、页 3 闲读都不允许出现"不可用"占位。
                    # 页 1 允许（例如赛季结束时的 MLB 赛程），别把正常降级也算失败。
                    if page >= 2:
                        self.assertNotIn('不可用', drawn)
                        self.assertNotIn('unavailable', drawn.lower())
                    # 'MM-DD' 与 'YYYY-MM-DD' 都必须读成 11月16日，不能画成 2026月11日。
                    if page == 2:
                        self.assertIn('11月16日' if lang == 'zh' else 'Nov 16', drawn)
                        self.assertNotIn('2026月', drawn)

    def test_cloud_single_page_has_no_swipe_hint(self):
        # 云端 Pages 只有一张图，写「1/3 · 左右滑换页」会误导人去滑一张滑不动的屏。
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'cloud.png'
            r.render(FIXTURE, str(out), 'zh')
            drawn = ' | '.join(r._DRAWN)
            self.assertNotIn('1/3', drawn)
            self.assertIn('顶部下滑返回', drawn)

    def test_invalid_page_falls_back_to_dashboard(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / 'odd.png'
            r.render(FIXTURE, str(out), 'zh', 99, 3)
            drawn = ' | '.join(r._DRAWN)
            self.assertIn('1/3', drawn)


if __name__ == '__main__':
    unittest.main()
