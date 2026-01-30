import { TFile } from 'obsidian';
import type { Vault } from 'obsidian';
import type { MemoItem } from '../models/settings';
import type { MemosService } from './memos-service';
import { Logger } from './logger';

export class FileService {
    private logger: Logger;

    constructor(
        private vault: Vault,
        private syncDirectory: string,
        private memosService: MemosService
    ) {
        this.logger = new Logger('FileService');
    }

    private formatDateTime(date: Date, format: 'filename' | 'display' = 'display'): string {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');

        if (format === 'filename') {
            return `${year}-${month}-${day}`;
        }
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }

    private sanitizeFileName(fileName: string): string {
        let sanitized = fileName.replace(/^[\\/:*?"<>|#\s]+/, '');

        sanitized = sanitized
            .replace(/\s+/g, ' ')
            .replace(/[\\/:*?"<>|#]/g, '')
            .trim();

        return sanitized || 'untitled';
    }

    private getRelativePath(fromPath: string, toPath: string): string {
        const fromParts = fromPath.split('/');
        const toParts = toPath.split('/');
        fromParts.pop();

        let i = 0;
        while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
            i++;
        }

        const goBack = fromParts.length - i;
        const relativePath = [
            ...Array(goBack).fill('..'),
            ...toParts.slice(i)
        ].join('/');

        return relativePath;
    }

    private isImageFile(filename: string): boolean {
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];
        const ext = filename.toLowerCase().split('.').pop();
        return ext ? imageExtensions.includes(`.${ext}`) : false;
    }

    private async ensureDirectoryExists(dirPath: string): Promise<void> {
        if (!(await this.vault.adapter.exists(dirPath))) {
            await this.vault.adapter.mkdir(dirPath);
        }
    }

    private getContentPreview(content: string): string {
        let preview = content
            .replace(/^>\s*\[!.*?\].*$/gm, '')
            .replace(/^>\s.*$/gm, '')
            .replace(/^\s*#\s+/gm, '')
            .replace(/[_*~`]|_{2,}|\*{2,}|~{2,}/g, '')
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
            .replace(/\n+/g, ' ')
            .trim();

        if (!preview) {
            return 'Untitled';
        }

        if (preview.length > 50) {
            preview = `${preview.slice(0, 50)}...`;
        }

        return preview;
    }

    private async getMemoFiles(): Promise<string[]> {
        const files: string[] = [];
        const processDirectory = async (dirPath: string) => {
            const items = await this.vault.adapter.list(dirPath);
            for (const file of items.files) {
                if (file.endsWith('.md')) {
                    files.push(file);
                }
            }
            for (const dir of items.folders) {
                await processDirectory(dir);
            }
        };

        await processDirectory(this.syncDirectory);
        return files;
    }

    async isMemoExists(memoId: string, memoDate: Date): Promise<boolean> {
        try {
            const year = memoDate.getFullYear();
            const month = String(memoDate.getMonth() + 1).padStart(2, '0');
            const day = String(memoDate.getDate()).padStart(2, '0');
            const dateStr = `${year}-${month}-${day}`;

            // 构建当日文件路径
            const monthDir = `${this.syncDirectory}`;
            const filePath = `${monthDir}/${dateStr}.md`;

            // 若文件不存在，直接返回false
            if (!(await this.vault.adapter.exists(filePath))) {
                return false;
            }

            // 若文件存在，检查是否包含当前Memo ID
            const content = await this.vault.adapter.read(filePath);
            return content.includes(`> - ID: ${memoId}`);
        } catch (error) {
            this.logger.error('检查 memo 是否存在时出错:', error instanceof Error ? error.message : String(error));
            return false;
        }
    }

    /* async isMemoExists(memoId: string): Promise<boolean> {
        try {
            const files = await this.getMemoFiles();
            for (const file of files) {
                const content = await this.vault.adapter.read(file);
                if (content.includes(`> - ID: ${memoId}`)) {
                    return true;
                }
            }
            return false;
        } catch (error) {
            this.logger.error('检查 memo 是否存在时出错:', error instanceof Error ? error.message : String(error));
            return false;
        }
    } */


    async saveMemoToFile(memo: MemoItem): Promise<void> {
        try {
            const date = new Date(memo.createTime);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');
            // 时间点前缀（例如：14:30）
            const timePrefix = `${hours}:${minutes}:${seconds}`;

            // 检查当前Memo是否已存在于当日文件中
            const exists = await this.isMemoExists(memo.name, date);
            if (exists) {
                this.logger.debug(`Memo ${memo.name} 已存在于当日文件，跳过`);
                return;
            }

            // 确保年/月目录存在
            //const yearDir = `${this.syncDirectory}/${year}`;
            const monthDir = `${this.syncDirectory}`;
            //await this.ensureDirectoryExists(yearDir);
            await this.ensureDirectoryExists(monthDir);

            // 构建当日文件路径（例如：2025/04/2025-04-20.md）
            const dateStr = `${year}-${month}-${day}`;
            const fileName = `${dateStr}.md`;
            const filePath = `${monthDir}/${fileName}`;

            // 处理Memo内容：替换标签格式 + 增加时间点前缀
            let memoContent = memo.content || '';
            memoContent = memoContent.replace(/\#([^\#\s]+)\#/g, '#$1'); // 标签格式转换
            // 为当前Memo增加时间点前缀 + 分隔线
            let newMemoBlock = `\n- ${timePrefix}\n`;
            newMemoBlock += memoContent;

            // 处理附件（图片/其他文件）
            if (memo.resources && memo.resources.length > 0) {
                const images = memo.resources.filter(r => this.isImageFile(r.filename));
                const otherFiles = memo.resources.filter(r => !this.isImageFile(r.filename));

                if (images.length > 0) {
                    newMemoBlock += '\n\n### 图片附件\n';
                    for (const image of images) {
                        const resourceData = await this.memosService.downloadResource(image);
                        if (resourceData) {
                            const resourceDir = `${monthDir}/resources`;
                            await this.ensureDirectoryExists(resourceDir);
                            const localFilename = `${image.name.split('/').pop()}_${this.sanitizeFileName(image.filename)}`;
                            const localPath = `${resourceDir}/${localFilename}`;
                            await this.vault.adapter.writeBinary(localPath, resourceData);
                            const relativePath = this.getRelativePath(filePath, localPath);
                            newMemoBlock += `![${image.filename}](${relativePath})\n`;
                        }
                    }
                }

                if (otherFiles.length > 0) {
                    newMemoBlock += '\n\n### 其他附件\n';
                    for (const file of otherFiles) {
                        const resourceData = await this.memosService.downloadResource(file);
                        if (resourceData) {
                            const resourceDir = `${monthDir}/resources`;
                            await this.ensureDirectoryExists(resourceDir);
                            const localFilename = `${file.name.split('/').pop()}_${this.sanitizeFileName(file.filename)}`;
                            const localPath = `${resourceDir}/${localFilename}`;
                            await this.vault.adapter.writeBinary(localPath, resourceData);
                            const relativePath = this.getRelativePath(filePath, localPath);
                            newMemoBlock += `- [${file.filename}](${relativePath})\n`;
                        }
                    }
                }
            }

            // 增加Memo属性（ID/创建时间等）
            newMemoBlock += '\n\n---\n';
            newMemoBlock += '> [!note]- Memo Properties\n';
            newMemoBlock += `> - Created: ${this.formatDateTime(new Date(memo.createTime))}\n`;
            newMemoBlock += `> - Updated: ${this.formatDateTime(new Date(memo.updateTime))}\n`;
            newMemoBlock += '> - Type: memo\n';
            const tags = (memo.content || '').match(/\#([^\#\s]+)(?:\#|\s|$)/g) || [];
            const cleanTags = tags.map(tag => tag.replace(/^\#|\#$/g, '').trim());
            if (cleanTags.length > 0) {
                newMemoBlock += `> - Tags: [${cleanTags.join(', ')}]\n`;
            }
            newMemoBlock += `> - ID: ${memo.name}\n`;
            newMemoBlock += `> - Visibility: ${memo.visibility.toLowerCase()}\n`;

            // 核心：读取当日文件内容 → 追加新Memo → 写入
            let finalContent = '';
            if (await this.vault.adapter.exists(filePath)) {
                // 文件已存在，读取原有内容
                finalContent = await this.vault.adapter.read(filePath);
            }
            // 追加新Memo内容
            finalContent += newMemoBlock;

            // 写入文件（覆盖式写入，因为已包含原有内容+新内容）
            try {
                const abstractFile = this.vault.getAbstractFileByPath(filePath);
                if (abstractFile instanceof TFile) {
                    await this.vault.modify(abstractFile, finalContent);
                } else {
                    await this.vault.create(filePath, finalContent);
                }
            } catch (error) {
                console.error(`Failed to save memo to file: ${filePath}`, error);
                throw new Error(`Failed to save memo: ${error.message}`);
            }
        } catch (error) {
            this.logger.error('保存 memo 到文件时出错:', error instanceof Error ? error.message : String(error));
            throw new Error(`保存 memo 失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}