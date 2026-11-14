# -*- coding: utf-8 -*-
"""页 2「慢信息」的本地计算：节气、月相、周末、公历节日、年进度。

设计约束（来自用户定位：家庭电脑旁，只是看看信息、放松下）：
  * 零网络、零第三方依赖、零数据文件 —— 不接任何日程/待办/知识系统；
  * 纯函数，输出都是「陈述」而不是「提醒」，没有倒计时式的催促语义；
  * 中英各一份文案，英文路径全程 ASCII（配合渲染器的 CJK 拦截）。

节气用 Meeus 低精度太阳黄经公式逐日插值，精度约一天内，且不依赖手抄的
年度节气表 —— 换到 2027、2030 年也不用回来改代码。它只用于「看看今天处在
一年里的哪一段」，不用于历法编排，所以不追求分秒级精度。
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# 太阳黄经每 15° 一个节气。顺序按黄经排，0° = 春分。
TERM_NAMES = {
    0: ('春分', 'Spring Equinox'),
    15: ('清明', 'Pure Brightness'),
    30: ('谷雨', 'Grain Rain'),
    45: ('立夏', 'Start of Summer'),
    60: ('小满', 'Grain Buds'),
    75: ('芒种', 'Grain in Ear'),
    90: ('夏至', 'Summer Solstice'),
    105: ('小暑', 'Minor Heat'),
    120: ('大暑', 'Major Heat'),
    135: ('立秋', 'Start of Autumn'),
    150: ('处暑', 'End of Heat'),
    165: ('白露', 'White Dew'),
    180: ('秋分', 'Autumn Equinox'),
    195: ('寒露', 'Cold Dew'),
    210: ('霜降', "Frost's Descent"),
    225: ('立冬', 'Start of Winter'),
    240: ('小雪', 'Minor Snow'),
    255: ('大雪', 'Major Snow'),
    270: ('冬至', 'Winter Solstice'),
    285: ('小寒', 'Minor Cold'),
    300: ('大寒', 'Major Cold'),
    315: ('立春', 'Start of Spring'),
    330: ('雨水', 'Rain Water'),
    345: ('惊蛰', 'Awakening of Insects'),
}

MOON_NAMES = [
    ('新月', 'New Moon'), ('蛾眉月', 'Waxing Crescent'),
    ('上弦月', 'First Quarter'), ('盈凸月', 'Waxing Gibbous'),
    ('满月', 'Full Moon'), ('亏凸月', 'Waning Gibbous'),
    ('下弦月', 'Last Quarter'), ('残月', 'Waning Crescent'),
]

# 只列公历固定的日子：农历节日每年浮动，写死反而会显示错误。
FIXED_DAYS = [
    (1, 1, '元旦', "New Year's Day"),
    (5, 1, '劳动节', 'Labour Day'),
    (10, 1, '国庆节', 'National Day'),
    (12, 25, '圣诞节', 'Christmas'),
]

NEW_MOON_EPOCH = datetime(2000, 1, 6, 18, 14, tzinfo=timezone.utc)
SYNODIC_MONTH = 29.530588853
J2000 = datetime(2000, 1, 1, 12, tzinfo=timezone.utc)


def _julian_days(dt):
    return (dt - J2000).total_seconds() / 86400.0


def _unwrapped_longitude(dt):
    """连续（不取模）的太阳视黄经，单位为度。

    不取模是为了让「跨过某个 15° 倍数」的判断在 360°->0° 回绕处也成立：
    从 J2000 起黄经单调增长，节气就是它每跨过一个 15° 网格点的时刻。
    """
    n = _julian_days(dt)
    g = math.radians(357.528 + 0.9856003 * n)
    return 280.460 + 0.9856474 * n + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g)


def solar_terms(year, tz='Asia/Shanghai'):
    """返回该年的 [(date, zh, en), ...]，按日期升序。"""
    zone = ZoneInfo(tz)
    start = datetime(year - 1, 12, 20, 12, tzinfo=timezone.utc)
    found = []
    previous = _unwrapped_longitude(start)
    for offset in range(1, 385):
        current = _unwrapped_longitude(start + timedelta(days=offset))
        k = math.floor(previous / 15) + 1
        while k * 15 <= current:
            fraction = (k * 15 - previous) / (current - previous)
            moment = start + timedelta(days=offset - 1 + fraction)
            local_day = moment.astimezone(zone).date()
            zh, en = TERM_NAMES[(k * 15) % 360]
            found.append((local_day, zh, en))
            k += 1
        previous = current
    result = [item for item in found if item[0].year == year]
    result.sort(key=lambda item: item[0])
    # 去重：插值边界极偶尔会让同一天出现两次。
    unique = []
    for item in result:
        if not unique or unique[-1][0] != item[0]:
            unique.append(item)
    return unique


def term_at(today, tz='Asia/Shanghai'):
    """当前节气与下一个节气：((zh, en, date), (zh, en, date, days))。"""
    terms = solar_terms(today.year, tz)
    if not terms:
        return None, None
    current = None
    upcoming = None
    for day, zh, en in terms:
        if day <= today:
            current = (zh, en, day)
        else:
            upcoming = (zh, en, day, (day - today).days)
            break
    if current is None:
        previous = solar_terms(today.year - 1, tz)
        if previous:
            day, zh, en = previous[-1]
            current = (zh, en, day)
    if upcoming is None:
        following = solar_terms(today.year + 1, tz)
        if following:
            day, zh, en = following[0]
            upcoming = (zh, en, day, (day - today).days)
    return current, upcoming


def moon_phase(today, tz='Asia/Shanghai'):
    """当天的月相 (zh, en) 与月龄天数。"""
    zone = ZoneInfo(tz)
    local_noon = datetime(today.year, today.month, today.day, 12, tzinfo=zone)
    age = ((local_noon.astimezone(timezone.utc) - NEW_MOON_EPOCH).total_seconds() / 86400.0) % SYNODIC_MONTH
    index = int(age / SYNODIC_MONTH * 8 + 0.5) % 8
    return MOON_NAMES[index], round(age, 1)


def days_to_weekend(today):
    """0 = 已经在周末里；否则到周六还有几天。"""
    return 0 if today.weekday() >= 5 else 5 - today.weekday()


def next_fixed_day(today):
    """下一个公历固定日子 (zh, en, date, days)；今天则 days=0。"""
    candidates = []
    for year in (today.year, today.year + 1):
        for month, day, zh, en in FIXED_DAYS:
            try:
                when = date(year, month, day)
            except ValueError:
                continue
            if when >= today:
                candidates.append((zh, en, when, (when - today).days))
    candidates.sort(key=lambda item: item[2])
    return candidates[0] if candidates else None


def year_progress(today):
    """今年已经过去的百分比（整数）。"""
    total = 366 if (today.year % 4 == 0 and (today.year % 100 != 0 or today.year % 400 == 0)) else 365
    return round(today.timetuple().tm_yday / total * 100)
