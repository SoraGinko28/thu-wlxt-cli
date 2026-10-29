# 网络学堂 CLI

非官方学生端命令行工具，支持学期、课程、公告、作业、资料查询与下载。基于 Node.js 22 或以上，运行时不需要 Python 或第三方依赖。自动登录目前需要 macOS 和 Google Chrome。

## 安装

在本机终端执行：

```sh
git clone https://github.com/SoraGinko28/thu-wlxt-cli.git
cd thu-wlxt-cli
npm install -g --prefix "$HOME/.local" .
wlxt-cli --help
```

也可以不安装，进入该目录后将下面命令中的 `wlxt-cli` 换为 `node bin/wlxt-cli.js`。这是本地 npm 包，尚未发布到 npm；不要使用 `npx` 从网络安装同名包。

## 登录

运行：

```sh
wlxt-cli auth login
```

程序打开独立的 Chrome 窗口，请在学校官方页面点击登录，完成认证及可能出现的二次验证。登录完成后保持窗口打开，程序会验证网络学堂会话，然后自动关闭窗口。无需复制 Cookie；五分钟内未完成登录会超时，可用 Ctrl+C 取消。这个窗口使用临时浏览器数据目录，不读取已有浏览器的登录状态。

成功后程序将网络学堂会话保存在本机的 `~/.config/wlxt/session.json`（或 `$XDG_CONFIG_HOME/wlxt/session.json`），目录和文件权限分别为 700 和 600，不保存账号密码。会话相当于登录凭据，到期后重复登录；`wlxt-cli auth logout` 删除本机保存的会话。

## 使用

```sh
wlxt-cli auth status
wlxt-cli semesters
wlxt-cli courses
wlxt-cli courses --semester 学期ID
wlxt-cli notifications 课程ID
wlxt-cli notification-attachments 课程ID 公告ID
wlxt-cli notification-download 课程ID 公告ID 附件ID -d ./downloads
wlxt-cli homework 课程ID
wlxt-cli homework-detail 课程ID 学生作业ID
wlxt-cli homework-download 课程ID 学生作业ID 附件ID -d ./downloads
wlxt-cli homework-feedback 课程ID 学生作业ID
wlxt-cli feedback-attachments 课程ID 学生作业ID
wlxt-cli feedback-download 课程ID 学生作业ID 附件ID -d ./downloads
wlxt-cli homework-submit 课程ID 学生作业ID --file 作业文件 [--text 正文]
wlxt-cli files 课程ID
wlxt-cli download 课程ID 文件ID -d ./downloads
wlxt-cli auth logout
```

学期 ID 来自 `semesters`，课程 ID 来自 `courses`，文件 ID 来自 `files`；学生作业 ID 为 `homework` 输出中的 `xszyid`；公告 ID 为 `notifications` 输出中的 `ggid`，附件 ID 分别从作业详情和公告附件列表获取。作业详情中的 `descriptionHtml` 是学校返回的富文本 HTML。提交作业会向学校发送真实内容；默认拒绝覆盖已交作业，重交需明确使用 `--replace`，可能覆盖此前提交的内容和附件，请先自行核对。暂不支持线下和小组作业，单个附件最大 100 MiB。反馈读取成绩和评语等列表字段；可查看教师批改附件并使用其附件 ID 下载。批改附件功能依据作业详情页面结构实现，当前账户没有批改附件样本，附件下载尚未使用真实批改文件验证。所有结果输出 JSON；失败时错误输出到 stderr，退出码非零。下载不会覆盖已有文件。JSON 中可能有个人信息，分享前请检查。

登录、公告、作业、反馈和资料查询，以及资料下载和作业提交已用真实账户验证；不同课程和作业的情况仍可能不同。资料列表接口的 `size=0` 依据第三方实现，其完整性尚无法保证，请与网页核对。该工具不绕过验证码和二次认证。学校提醒[第三方客户端不是官方软件](https://www.tsinghua.edu.cn/en/info/1346/9196.htm)。接口参考 [thu-learn-lib](https://github.com/Harry-Chen/thu-learn-lib) 和 [learn2018-autodown](https://github.com/Trinkle23897/learn2018-autodown)。
