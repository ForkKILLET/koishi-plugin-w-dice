import { $, Context, Schema as z, Session, h, Tables, Keys, Query, Indexable, Awaitable, Create } from 'koishi'
import {} from '@koishijs/plugin-help'
import {} from 'koishi-plugin-w-echarts'

import dayjs from 'dayjs'
import dayjsCustomParseFormatPlugin from 'dayjs/plugin/customParseFormat'
dayjs.extend(dayjsCustomParseFormatPlugin)

export const name = 'w-dice'

export const inject = ['database', 'echarts']

export interface RpEvent {
  on: {
    year?: number
    month?: number
    date?: number
  }
  rp: number
  reason: string
}

export interface Config {
  rpEvents: RpEvent[]
}

export const Config: z<Config> = z.object({
  rpEvents: z.array(z.object({
    on: z.object({
      year: z.number(),
      month: z.number(),
      date: z.number()
    }).required(),
    rp: z.number().required(),
    reason: z.string().required()
  }))
})

declare module 'koishi' {
  interface Tables {
    'w-jrrp-record-v2': JrrpRecord_v2
    'w-jrrp-name': JrrpName
  }
}

export interface JrrpRecord_v1 {
  id: number
  uid: string
  day: number
  rp: number
}

export interface JrrpRecord_v2 {
  uid: string
  day: string
  rp: number
  isEvent?: boolean
}

export type JrrpRecord = JrrpRecord_v2

export interface JrrpName {
  uid: string
  name: string
}

export function apply(ctx: Context, config: Config) {
  ctx.model.extend('w-jrrp-record-v2', {
    uid: 'string',
    day: 'string',
    rp: 'unsigned',
    isEvent: 'boolean',
  }, {
    primary: ['uid', 'day']
  })

  ctx.model.extend('w-jrrp-name', {
    uid: 'string',
    name: 'string'
  }, {
    primary: 'uid'
  })

  const getOrInitWith = async <K extends Keys<Tables>>(
    table: K,
    index: Query.Shorthand<Indexable>,
    initializer: () => Awaitable<Create<Tables[K], Tables>>
  ): Promise<Tables[K]> => {
    const [rec] = await ctx.database.get(table, index)
    if (rec) return rec
    const newRec = await initializer()
    return ctx.database.create(table, newRec)
  }

  const getUsername = ({ uid, event: { user } }: Session) => (
    getOrInitWith('w-jrrp-name', uid, () => ({
      uid,
      name: user.nick || user.name
    }))
    .then(rec => rec.name)
  )

  interface TopOptions {
    max: number
    global: boolean
    reverse: boolean
    chart: boolean
  }

  interface TopRec {
    uid: string
    value: number
    subValue?: number
  }

  async function getTop({
    isToday,
    min = 0,
    max = 100,
    session,
    options,
    label,
    getRecs,
    formatter,
  }: {
    isToday: boolean,
    min?: number,
    max?: number,
    session: Session,
    options: Partial<TopOptions>,
    label: string,
    getRecs: () => Promise<TopRec[]>,
    formatter: (rec: TopRec) => string
  }) {
    const { uid, guildId: gid } = session

    if (! gid && ! options.global) return '请在群内调用'

    const [name, { data: members }, list] = await Promise.all([
      getUsername(session),
      session.bot.getGuildMemberList(gid),
      getRecs(),
    ])

    const sortedList = (await Promise
      .all(list.map(async ({ uid, value, subValue }) => {
        const [userPlatform, userId] = uid.split(':')
        if (! options.global && (
          userPlatform !== session.event.platform ||
          ! members.some(member => member.user.id === userId)
        )) return null
        const [rec] = await ctx.database.get('w-jrrp-name', { uid })
        const name = rec?.name ?? uid
        return {
          uid, name, value, subValue,
        }
      })))
      .filter(rec => !! rec)
      .sort(options.reverse
        ? (rec1, rec2) => rec1.value - rec2.value
        : (rec1, rec2) => rec2.value - rec1.value
      )

    const todayLabel = isToday ? '今日' : ''
    const reverseLabel = options.reverse ? '倒数' : ''

    if (! sortedList.length) return `${todayLabel}还没有人测过人品哦`

    const topList = sortedList.slice(0, options.max || undefined)

    const value = topList.find(rec => rec.uid === uid)?.value ?? null
    const rank = value === null ? null : topList.findIndex(rec => rec.value === value) + 1
    const rankMsg = `${name} ${rank !== null
      ? `${name} ${todayLabel}${label}排名是${reverseLabel}第 ${rank}`
      : sortedList.some(rec => rec.uid === uid)
        ? `${name} ${todayLabel}${label}未上榜`
        : `${name} ${todayLabel}还没有测过人品`
    }`

    if (! options.chart) return `${rankMsg}\n${todayLabel}${label}排行榜\n` + topList
      .map((rec, i) => `${rec.uid === uid ? '＊' : '\u3000'} ${i + 1}. ${rec.name}: ${rec.value}`)
      .join('\n')

    topList.reverse() // ECharts 图表顺序从下向上

    const eh = ctx.echarts.createChart(800, 500 + (topList.length - 10) * 10, {
      xAxis: {
        type: 'value',
        name: label,
        min,
        max,
      },
      yAxis: {
        type: 'category',
        name: '用户',
        data: topList.map(rec => rec.name),
        axisLabel: {
          overflow: 'truncate',
          width: 100,
          interval: 0,
        },
      },
      grid: {
        left: 110,
      },
      series: {
        type: 'bar',
        data: topList.map(rec => ({
          value: rec.value,
          itemStyle: { color: rec.uid === uid ? colors.accent : colors.primary },
          label: {
            position: rec.value >= 0 ? 'right' : 'left',
          }
        })),
        label: {
          show: true,
          formatter: (params) => formatter(topList[params.dataIndex]),
        },
      },
      backgroundColor: '#fff'
    })

    return [
      h.text(rankMsg),
      await eh.export(),
    ]
  }

  const colors = {
    primary: '#73b9bc',
    secondary: '#91ca8c',
    tertiary: '#d48265',
    accent: '#f49f42'
  } as const

  ctx.command('jrrp', '查看今日人品')
    .action(async ({ session }) => {
      const { uid } = session

      const d = dayjs()
      const day = d.format('YYYY-MM-DD')

      const [name, [rec]] = await Promise.all([
        getUsername(session),
        ctx.database.get('w-jrrp-record-v2', { uid, day })
      ])

      const event = config.rpEvents.find(({ on }) => {
        if ('year' in on && on.year !== d.year()) return false
        if ('month' in on && on.month !== d.month() + 1) return false
        if ('date' in on && on.date !== d.date()) return false
        return true
      })

      if (event) {
        await ctx.database.upsert('w-jrrp-record-v2', [{ uid, day, rp: event.rp, isEvent: true }])
        return `${name} 今天的人品是 ${event.rp}，因为${event.reason}`
      }

      if (rec) return `${name} 今天已经测过人品啦，是 ${rec.rp}，再怎么测都不会变的了啦……`

      const rp = Math.floor(Math.random() * 101)
      await ctx.database.create('w-jrrp-record-v2', { uid, day, rp })
      return `${name} 今天的人品是 ${rp}`
    })

  ctx.command('jrrp.top', '查看群内今日人品排行')
    .option('max', '-m <max:number> 设置最大显示人数', { fallback: Infinity })
    .option('global', '-G 查看全局排行榜（所有群）')
    .option('reverse', '-r 逆序显示')
    .option('chart', '-c 显示图表', { fallback: true })
    .option('chart', '-C 不显示图表（文本形式）', { value: false })
    .action(({ session, options }) => getTop({
      isToday: true,
      session,
      options,
      label: '人品',
      getRecs: () => ctx.database
        .select('w-jrrp-record-v2')
        .where({ day: dayjs().format('YYYY-MM-DD'), isEvent: { $not: true } })
        .project({ value: 'rp', uid: 'uid' })
        .execute(),
      formatter: ({ value }) => String(value),
    }))

  ctx.command('jrrp.average', '查看我的人品均值')
    .alias('jrrp.avg')
    .action(async ({ session }) => {
      const { uid } = session
      const [name, [{ average, times } = { average: 0, times: 0 }]] = await Promise.all([
        getUsername(session),
        ctx.database
          .select('w-jrrp-record-v2')
          .where({ uid, isEvent: { $not: true } })
          .groupBy([], ({
            average: row => $.avg(row.rp),
            times: row => $.count(row.day),
          }))
          .execute(),
      ])
      return `${name} 的平均人品在共 ${times} 次测量中是 ${average.toFixed(2)}`
    })

  ctx.command('jrrp.average.top', '查看群内平均人品排行')
    .option('max', '-m <max:number> 设置最大显示人数', { fallback: Infinity })
    .option('global', '-G 查看全局排行榜（所有群）')
    .option('reverse', '-r 逆序显示')
    .option('chart', '-c 显示图表', { fallback: true })
    .option('chart', '-C 不显示图表（文本形式）', { value: false })
    .action(({ session, options }) => getTop({
      isToday: false,
      session,
      options,
      label: '平均人品',
      getRecs: () => ctx.database
        .select('w-jrrp-record-v2')
        .where({ isEvent: { $not: true } })
        .groupBy('uid', {
          value: row => $.avg(row.rp),
          subValue: row => $.count(row.day),
        })
        .execute(),
      formatter: ({ value, subValue }) => `${value.toFixed(2)} | ${subValue}`,
    }))

  const LUKCY_PENALTY_DAY = 20
  const LUKCY_MEAN = 50
  const LUKCY_PENALTY = LUKCY_MEAN * LUKCY_PENALTY_DAY

  const showNumberSigned = (x: number, show: (x: number) => string) =>
    (x >= 0 ? '+' : '') + show(x)

  const showLuckyScore = (score: number) => showNumberSigned(score, x => x.toFixed(2))

  ctx.command('jrrp.lucky', '查看我的幸运度')
    .action(async ({ session }) => {
      const { uid } = session
      const [name, [{ average, times } = { average: 0, times: 0 }]] = await Promise.all([
        getUsername(session),
        ctx.database
          .select('w-jrrp-record-v2')
          .where({ uid, isEvent: { $not: true } })
          .groupBy([], ({
            average: row => $.avg(row.rp),
            times: row => $.count(row.day),
          }))
          .execute(),
      ])

      const luckyScoreRaw = (average * times + LUKCY_PENALTY) / (times + LUKCY_PENALTY_DAY)
      const luckyScore = (luckyScoreRaw - 50) * 2
      const luckyScoreStr = showLuckyScore(luckyScore)

      return `${name} 的幸运度是 ${luckyScoreStr}`
    })

  ctx.command('jrrp.lucky.top', '查看群内幸运度排行')
    .option('max', '-m <max:number> 设置最大显示人数', { fallback: Infinity })
    .option('global', '-G 查看全局排行榜（所有群）')
    .option('reverse', '-r 逆序显示')
    .option('chart', '-c 显示图表', { fallback: true })
    .option('chart', '-C 不显示图表（文本形式）', { value: false })
    .action(({ session, options }) => getTop({
      isToday: false,
      min: - 100,
      max: + 100,
      session,
      options,
      label: '幸运度',
      getRecs: () => ctx.database
        .select('w-jrrp-record-v2')
        .where({ isEvent: { $not: true } })
        .groupBy('uid', {
          value: row => $.mul(
            $.sub(
              $.div(
                $.add($.sum(row.rp), LUKCY_PENALTY),
                $.add($.count(row.day), LUKCY_PENALTY_DAY)
              ),
              50
            ),
            2,
          )
        })
        .execute(),
      formatter: ({ value }) => showLuckyScore(value),
    }))

  ctx.command('jrrp.calendar [month:string]', '查看我的人品日历')
    .action(async ({ session }, month) => {
      const { uid } = session

      const date = month ? dayjs(month, 'YYYY-MM', true) : dayjs()
      if (! date.isValid()) return `${month} 不是合法的月份，月份格式应为 YYYY-MM`
      month = date.format('YYYY-MM')

      const [name, data] = await Promise.all([
        getUsername(session),
        ctx.database
          .get('w-jrrp-record-v2', {
            uid,
            day: { $regex: `^${month}-` }
          })
          .then(recs => recs.map(rec => [rec.day, rec.rp])),
      ])

      const globalFontFamily = ctx.echarts.config.font

      const eh = ctx.echarts.createChart(420, 320, {
        calendar: {
          orient: 'vertical',
          yearLabel: {
            margin: 40,
            color: '#000',
            fontSize: 22,
            fontWeight: 800,
            fontFamily: globalFontFamily,
          },
          monthLabel: {
            nameMap: 'cn',
            margin: 20,
            fontSize: 20,
            fontWeight: 600,
            fontFamily: globalFontFamily,
          },
          dayLabel: {
            nameMap: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
            firstDay: 1,
            fontSize: 17,
            fontFamily: globalFontFamily,
          },
          cellSize: 40,
          range: month
        },
        visualMap: {
          min: 0,
          max: 100,
          calculable: true,
          show: false,
        },
        series: {
          type: 'heatmap',
          silent: true,
          label: {
            show: true,
            formatter: ({ data }) => String(data[1])
          },
          coordinateSystem: 'calendar',
          data
        },
        backgroundColor: '#fff'
      })

      return [
        `${name} 在 ${month} 的人品日历`,
        await eh.export()
      ]
    })

  const getJrrpRecs = (uid: string) => ctx.database
    .get('w-jrrp-record-v2', { uid })
    .then(recs => recs.sort((rec1, rec2) => + dayjs(rec1.day) - + dayjs(rec2.day)))

  type LineSeriesOption = echarts.RegisteredSeriesOption['line']

  const getJrrpSeries = (recs: Awaited<ReturnType<typeof getJrrpRecs>>, color: string): LineSeriesOption => ({
    type: 'line',
    data: recs.map(({ day, rp }) => [day, String(rp)] as const),
    label: { show: true },
    lineStyle: { color },
    itemStyle: { color },
  })

  ctx.command('jrrp.history', '查看我的人品历史')
    .option('chart', '-c 显示图表', { fallback: true })
    .option('chart', '-C 不显示图表（文本形式）', { value: false })
    .option('diff', '-d <target:user> 指定比较的用户')
    .action(async ({
      session,
      options: { diff: diffTarget, chart: useChart }
    }) => {
      if (diffTarget && ! useChart) return 'diff 选项必须在图表模式下使用'

      const { uid } = session
      const [selfRecs, targetRecs] = await Promise.all([
        getJrrpRecs(uid),
        diffTarget ? getJrrpRecs(diffTarget) : undefined
      ])

      if (! useChart) {
        if (! selfRecs.length) return '你还没有测过人品'
        return selfRecs
          .map(({ day, rp }) => `${ dayjs(day).format('YYYY-MM-DD') }: ${rp}`)
          .join('\n')
      }

      const eh = ctx.echarts.createChart(800, 500, {})

      const series: LineSeriesOption[] = [getJrrpSeries(selfRecs, colors.primary)]
      if (diffTarget) series.push(getJrrpSeries(targetRecs, colors.secondary))

      eh.chart.setOption({
        xAxis: {
          type: 'category',
          data: [...new Set([
            ...selfRecs.map(rec => rec.day),
            ...targetRecs?.map(rec => rec.day) ?? []
          ])].sort((day1, day2) => + dayjs(day1) - + dayjs(day2))
        },
        yAxis: {
          type: 'value',
          name: '人品',
          min: 0,
          max: 100,
        },
        series,
        backgroundColor: '#fff'
      } satisfies echarts.EChartsOption)

      return eh.export()
    })

  ctx.command('jrrp.callme <name:string>', '修改自己的称呼')
    .action(async ({ session: { uid } }, name) => {
      await ctx.database.upsert('w-jrrp-name', [{ uid, name }])
      return `好的，${name}，请多指教！`
    })
}
