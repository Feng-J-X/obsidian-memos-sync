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

    async isMemoExists(memoId: string): Promise<boolean> {
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
    }

    async saveMemoToFile(memo: MemoItem): Promise<void> {
        try {
            const exists = await this.isMemoExists(memo.name);
            if (exists) {
                this.logger.debug(`Memo ${memo.name} 已存在，跳过`);
                return;
            }

            const date = new Date(memo.createTime);
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            
            //const yearDir = `${this.syncDirectory}`;
            const monthDir = `${this.syncDirectory}`;
            
            //await this.ensureDirectoryExists(yearDir);
            await this.ensureDirectoryExists(monthDir);
            
            const contentPreview = memo.content 
                ? this.getContentPreview(memo.content)
                : this.sanitizeFileName(memo.name.replace('memos/', ''));
            
            const timeStr = this.formatDateTime(date, 'filename');
            const fileName = this.sanitizeFileName(`${timeStr}.md`);
            const filePath = `${monthDir}/${fileName}`;
            
            let content = memo.content || '';
            content = content.replace(/\#([^\#\s]+)\#/g, '#$1');
            
            let documentContent = content;

            if (memo.resources && memo.resources.length > 0) {
                const images = memo.resources.filter(r => this.isImageFile(r.filename));
                const otherFiles = memo.resources.filter(r => !this.isImageFile(r.filename));

                if (images.length > 0) {
                    documentContent += '\n\n';
                    for (const image of images) {
                        const resourceData = await this.memosService.downloadResource(image);
                        if (resourceData) {
                            const resourceDir = `${monthDir}/resources`;
                            await this.ensureDirectoryExists(resourceDir);
                            const localFilename = `${image.name.split('/').pop()}_${this.sanitizeFileName(image.filename)}`;
                            const localPath = `${resourceDir}/${localFilename}`;
                            
                            await this.vault.adapter.writeBinary(localPath, resourceData);
                            const relativePath = this.getRelativePath(filePath, localPath);
                            documentContent += `![${image.filename}](${relativePath})\n`;
                        }
                    }
                }

                if (otherFiles.length > 0) {
                    documentContent += '\n\n### Attachments\n';
                    for (const file of otherFiles) {
                        const resourceData = await this.memosService.downloadResource(file);
                        if (resourceData) {
                            const resourceDir = `${monthDir}/resources`;
                            await this.ensureDirectoryExists(resourceDir);
                            const localFilename = `${file.name.split('/').pop()}_${this.sanitizeFileName(file.filename)}`;
                            const localPath = `${resourceDir}/${localFilename}`;
                            
                            await this.vault.adapter.writeBinary(localPath, resourceData);
                            const relativePath = this.getRelativePath(filePath, localPath);
                            documentContent += `- [${file.filename}](${relativePath})\n`;
                        }
                    }
                }
            }

            const tags = (memo.content || '').match(/\#([^\#\s]+)(?:\#|\s|$)/g) || [];
            const cleanTags = tags.map(tag => tag.replace(/^\#|\#$/g, '').trim());
            
            documentContent += '\n\n---\n';
            documentContent += '> [!note]- Memo Properties\n';
            documentContent += `> - Created: ${this.formatDateTime(new Date(memo.createTime))}\n`;
            documentContent += `> - Updated: ${this.formatDateTime(new Date(memo.updateTime))}\n`;
            documentContent += '> - Type: memo\n';
            if (cleanTags.length > 0) {
                documentContent += `> - Tags: [${cleanTags.join(', ')}]\n`;
            }
            documentContent += `> - ID: ${memo.name}\n`;
            documentContent += `> - Visibility: ${memo.visibility.toLowerCase()}\n`;

            try {
                const exists = await this.vault.adapter.exists(filePath);
                if (exists) {
                    const abstractFile = this.vault.getAbstractFileByPath(filePath);
                    if (abstractFile instanceof TFile) {
                        await this.vault.modify(abstractFile, documentContent);
                    } else {
                        throw new Error('Invalid file type');
                    }
                } else {
                    await this.vault.create(filePath, documentContent);
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