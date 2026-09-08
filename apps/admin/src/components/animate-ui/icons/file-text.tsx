'use client';

import { motion, type Variants } from 'motion/react';

import {
  getVariants,
  useAnimateIconContext,
  IconWrapper,
  type IconProps,
} from '@/components/animate-ui/icons/icon';

type FileTextProps = IconProps<keyof typeof animations>;

const animations = {
  default: {
    group: {
      initial: {
        scale: 1,
        transition: { type: 'spring', stiffness: 150, damping: 25 },
      },
      animate: {
        scale: 1,
        transition: { type: 'spring', stiffness: 150, damping: 25 },
      },
    },
    path1: {},
    path2: {},
    path3: {},
    path4: {},
    path5: {},
  } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: FileTextProps) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(animations);

  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      variants={variants.group}
      initial="initial"
      animate={controls}
      {...props}
    >
      <motion.path
        d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"
        variants={variants.path1}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M14 2v4a2 2 0 0 0 2 2h4"
        variants={variants.path2}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M10 9H8"
        variants={variants.path3}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M16 13H8"
        variants={variants.path4}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M16 17H8"
        variants={variants.path5}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}

function FileText(props: FileTextProps) {
  return <IconWrapper icon={IconComponent} {...props} />;
}

export {
  animations,
  FileText,
  FileText as FileTextIcon,
  type FileTextProps,
  type FileTextProps as FileTextIconProps,
};
