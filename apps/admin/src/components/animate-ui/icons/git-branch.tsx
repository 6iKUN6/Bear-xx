'use client';

import { motion, type Variants } from 'motion/react';

import {
  getVariants,
  useAnimateIconContext,
  IconWrapper,
  type IconProps,
} from '@/components/animate-ui/icons/icon';

type GitBranchProps = IconProps<keyof typeof animations>;

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
  } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: GitBranchProps) {
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
        d="M6 3v12"
        variants={variants.path1}
        initial="initial"
        animate={controls}
      />
      <motion.circle
        cx="18"
        cy="6"
        r="3"
        variants={variants.path2}
        initial="initial"
        animate={controls}
      />
      <motion.circle
        cx="6"
        cy="18"
        r="3"
        variants={variants.path3}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M18 9a9 9 0 0 1-9 9"
        variants={variants.path4}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}

function GitBranch(props: GitBranchProps) {
  return <IconWrapper icon={IconComponent} {...props} />;
}

export {
  animations,
  GitBranch,
  GitBranch as GitBranchIcon,
  type GitBranchProps,
  type GitBranchProps as GitBranchIconProps,
};
